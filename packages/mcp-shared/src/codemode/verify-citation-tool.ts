/**
 * Verify-citation tool factory — a shared MCP tool that re-checks the integrity
 * anchors of a previously-issued citation.
 *
 * A {@link Citation} (see `../provenance/provenance`) carries two anchors:
 *   - `result_hash = sha256(canonicalJson(result))` — WHAT came back
 *   - `query_hash  = sha256(canonicalJson(query))`  — WHAT was asked
 *     (for `<prefix>_execute` citations, `query` is the raw code STRING)
 *
 * This tool recomputes either/both from caller-supplied values and reports
 * whether they match — using the SAME canonicalization + sha256 that produced
 * the citation. Two protocols it enables:
 *
 *   1. Integrity: prove cited bytes were not altered
 *      → { expected_hash: citation.result_hash, data: <the claimed data> }
 *        (back-compatible: still returns flat { verified, expected_hash, actual_hash })
 *   2. REPLAY (adjudicating disagreements between agents/models): prove that
 *      a piece of code IS the cited query, then re-run it and compare.
 *      → { query_hash: citation.query_hash, query: "<exact code string>" }
 *        …if verified, re-execute that exact code via the server's
 *        `<prefix>_execute` tool and verify the fresh result with
 *        { expected_hash: citation.result_hash, data: <fresh result> }.
 *      Disagreements are settled by replay, never by plausibility.
 *
 * This is an opt-in compatibility surface for consumers that cannot run the
 * shared verification primitives locally. Bio MCP servers no longer advertise
 * it automatically; the portal verifies citations deterministically as each
 * result arrives. If explicitly registered elsewhere, both fleet-required tool
 * aliases are installed.
 */

import { z } from "zod";
import {
	type Citation,
	canonicalJson,
	sha256Hex,
	type VerifyResult,
	verifyResultHash,
} from "../provenance/provenance";
import {
	type CitationJwk,
	importCitationPublicKey,
	type SignatureVerdict,
	verifyCitationSignature,
} from "../provenance/signing";
import {
	createCodeModeError,
	createCodeModeResponse,
	ErrorCodes,
} from "./response";

/** The Zod input schema for the verify-citation tool. */
export interface VerifyCitationSchema {
	expected_hash: z.ZodOptional<z.ZodString>;
	data: z.ZodOptional<z.ZodUnknown>;
	query_hash: z.ZodOptional<z.ZodString>;
	query: z.ZodOptional<z.ZodUnknown>;
	baseline: z.ZodOptional<z.ZodUnknown>;
	citation: z.ZodOptional<z.ZodUnknown>;
	public_jwk: z.ZodOptional<z.ZodUnknown>;
}

export interface VerifyCitationToolResult {
	/** Primary registered tool name. */
	name: string;
	/** Human/agent-readable description. */
	description: string;
	/** Zod input schema (raw shape passed to `server.tool`). */
	schema: VerifyCitationSchema;
	/** Register the `verify_citation` tool on an MCP server. */
	register: (server: { tool: (...args: unknown[]) => void }) => void;
}

const TOOL_NAME = "verify_citation";

const DESCRIPTION =
	"Re-check a citation's integrity anchors. Result integrity: pass " +
	"{ expected_hash: <Citation.result_hash>, data: <claimed data> } to confirm cited bytes " +
	"were not altered. Query identity / REPLAY: pass { query_hash: <Citation.query_hash>, " +
	"query: <the exact query> } to confirm a query IS the one cited — for <prefix>_execute " +
	"citations the query is the raw code STRING. To adjudicate a disagreement (e.g. another " +
	"agent's result looks wrong), verify query identity, re-run that exact code via " +
	"<prefix>_execute, then verify the fresh result against the cited result_hash — replay, " +
	"don't judge by plausibility. Drift detail: add `baseline` (the originally-cited result) to " +
	"get a structural diff of what changed vs the fresh `data`, plus whether the baseline itself " +
	"hashed to the cited result_hash. Signature / ATTESTATION: pass { citation: <the full " +
	"Citation object>, public_jwk: <the issuing server's public JWK from its " +
	"/.well-known/jwks.json> } to verify the citation's Ed25519 signature offline — proof the " +
	"SERVER vouched for it, not merely that bytes reproduce a hash. Returns { verified, " +
	"expected_hash?, actual_hash?, query_check?, drift?, signature_check?, replay_hint? }. A " +
	"mismatch is a normal negative verdict (verified:false), not a tool error.";

interface VerifyCitationInput {
	expected_hash?: string;
	data?: unknown;
	query_hash?: string;
	query?: unknown;
	baseline?: unknown;
	citation?: unknown;
	public_jwk?: unknown;
}

interface CitationChecks {
	result_check?: VerifyResult;
	query_check?: VerifyResult;
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

async function runChecks(input: VerifyCitationInput): Promise<CitationChecks> {
	const checks: CitationChecks = {};
	if (isNonEmptyString(input.expected_hash)) {
		checks.result_check = await verifyResultHash(
			input.expected_hash,
			input.data,
		);
	}
	if (isNonEmptyString(input.query_hash)) {
		checks.query_check = await verifyResultHash(input.query_hash, input.query);
	}
	return checks;
}

/**
 * Verify a citation's embedded Ed25519 signature against a caller-supplied
 * public JWK (obtained from the issuing server's JWKS). Returns undefined when
 * the attestation mode was not requested; a "malformed" verdict when the key or
 * signature block is unusable.
 */
async function runSignatureCheck(
	input: VerifyCitationInput,
): Promise<SignatureVerdict | undefined> {
	if (input.citation === undefined || input.public_jwk === undefined) {
		return undefined;
	}
	try {
		const key = await importCitationPublicKey(input.public_jwk as CitationJwk);
		return await verifyCitationSignature(input.citation as Citation, key);
	} catch {
		return { verified: false, reason: "malformed" };
	}
}

/** Bounded structural diff of two JSON values — see {@link structuralDrift}. */
export interface DriftSummary {
	/** True when any leaf path was added, removed, or changed. */
	changed: boolean;
	/** Leaf paths present in `data` but not `baseline` (capped). */
	added: string[];
	/** Leaf paths present in `baseline` but not `data` (capped). */
	removed: string[];
	/** Leaf paths present in both whose canonical value differs (capped). */
	changed_paths: string[];
	/** True when any list was capped — the diff is partial, not the verdict. */
	truncated: boolean;
}

/** Max paths reported per bucket. The verdict is the hash; this is just detail. */
const DRIFT_PATH_CAP = 25;

/**
 * Flatten a JSON value to `path -> canonical-leaf-string`. Paths are advisory
 * (a dotted/indexed address for humans); a key literally containing "." can
 * collide, which only blurs the diff DISPLAY, never the hash verdict.
 */
function flattenLeaves(
	value: unknown,
	prefix: string,
	out: Map<string, string>,
): void {
	if (value === null || typeof value !== "object") {
		out.set(prefix || "$", canonicalJson(value));
		return;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			out.set(prefix || "$", "[]");
			return;
		}
		value.forEach((v, i) => {
			flattenLeaves(v, `${prefix}[${i}]`, out);
		});
		return;
	}
	const entries = Object.entries(value as Record<string, unknown>).filter(
		([, v]) => v !== undefined,
	);
	if (entries.length === 0) {
		out.set(prefix || "$", "{}");
		return;
	}
	for (const [k, v] of entries) {
		flattenLeaves(v, prefix ? `${prefix}.${k}` : k, out);
	}
}

/**
 * Bounded, deterministic structural diff between a `baseline` and `data` JSON
 * value, over the SAME canonicalization used to hash citations. Turns a bare
 * hash mismatch into "what changed" — the drift-vs-tamper distinction. Paths
 * are advisory; the load-bearing verdict is always the hash comparison.
 */
export function structuralDrift(
	baseline: unknown,
	data: unknown,
): DriftSummary {
	const a = new Map<string, string>();
	const b = new Map<string, string>();
	flattenLeaves(baseline, "", a);
	flattenLeaves(data, "", b);
	const added: string[] = [];
	const removed: string[] = [];
	const changed_paths: string[] = [];
	for (const [p, v] of a) {
		if (!b.has(p)) removed.push(p);
		else if (b.get(p) !== v) changed_paths.push(p);
	}
	for (const p of b.keys()) if (!a.has(p)) added.push(p);
	added.sort();
	removed.sort();
	changed_paths.sort();
	const truncated =
		added.length > DRIFT_PATH_CAP ||
		removed.length > DRIFT_PATH_CAP ||
		changed_paths.length > DRIFT_PATH_CAP;
	return {
		changed: added.length > 0 || removed.length > 0 || changed_paths.length > 0,
		added: added.slice(0, DRIFT_PATH_CAP),
		removed: removed.slice(0, DRIFT_PATH_CAP),
		changed_paths: changed_paths.slice(0, DRIFT_PATH_CAP),
		truncated,
	};
}

/** A drift report anchored to a hash: the diff plus the baseline's integrity. */
interface DriftReport extends DriftSummary {
	/** sha256(canonicalJson(baseline)) — so the compared original is re-checkable. */
	baseline_hash: string;
	/** When `expected_hash` was supplied: did the baseline hash to it? */
	baseline_matches_expected?: boolean;
}

/**
 * Compute drift only when both a `baseline` and `data` are present. Anchors the
 * baseline with its own hash and (if a cited hash was given) whether the claimed
 * original was authentic — the anti-fabrication half of replay adjudication.
 */
async function computeDrift(
	input: VerifyCitationInput,
): Promise<DriftReport | undefined> {
	if (input.baseline === undefined || input.data === undefined)
		return undefined;
	const summary = structuralDrift(input.baseline, input.data);
	const baseline_hash = await sha256Hex(canonicalJson(input.baseline));
	const report: DriftReport = { ...summary, baseline_hash };
	if (isNonEmptyString(input.expected_hash)) {
		report.baseline_matches_expected = baseline_hash === input.expected_hash;
	}
	return report;
}

function describeCheck(label: string, check: VerifyResult | undefined): string {
	if (!check) return "";
	return check.verified
		? ` ${label} verified (sha256:${check.actual_hash.slice(0, 12)}).`
		: ` ${label} MISMATCH: expected sha256:${check.expected_hash.slice(0, 12)}, got sha256:${check.actual_hash.slice(0, 12)}.`;
}

function describeDrift(drift: DriftReport | undefined): string {
	if (!drift) return "";
	if (!drift.changed) return " No drift vs baseline.";
	const parts = [
		drift.changed_paths.length ? `${drift.changed_paths.length} changed` : "",
		drift.added.length ? `${drift.added.length} added` : "",
		drift.removed.length ? `${drift.removed.length} removed` : "",
	].filter(Boolean);
	return ` Drift vs baseline: ${parts.join(", ")}${drift.truncated ? " (partial)" : ""}.`;
}

function replayHintFor(
	checks: CitationChecks,
	hasBaseline: boolean,
): string | undefined {
	if (checks.query_check?.verified && !checks.result_check) {
		return (
			"Query identity confirmed — to finish adjudication, re-run this exact code via the " +
			"server's <prefix>_execute tool, then call verify_citation again with " +
			"{ expected_hash: <cited result_hash>, data: <fresh result> }."
		);
	}
	if (checks.result_check && !checks.result_check.verified && !hasBaseline) {
		return (
			"Result mismatch — this is drift or a bad citation. To see WHAT changed, pass the " +
			"originally-cited result as `baseline` alongside the fresh `data`."
		);
	}
	return undefined;
}

/**
 * Assemble the response payload. Back-compatible: when a result-integrity check
 * ran, its `expected_hash`/`actual_hash` stay at the TOP level (the original
 * single-pair contract). Query-identity adds `query_check` + a `replay_hint`.
 */
function describeSignature(verdict: SignatureVerdict | undefined): string {
	if (!verdict) return "";
	if (verdict.verified) {
		return ` Signature verified${verdict.key_id ? ` (kid ${verdict.key_id})` : ""}.`;
	}
	return ` Signature NOT verified (${verdict.reason ?? "failed"}).`;
}

function buildPayload(
	checks: CitationChecks,
	drift: DriftReport | undefined,
	signature_check: SignatureVerdict | undefined,
): {
	payload: Record<string, unknown>;
	verified: boolean;
	textSummary: string;
} {
	const present = [checks.result_check, checks.query_check].filter(
		(c): c is VerifyResult => c !== undefined,
	);
	const coreVerified = present.every((c) => c.verified);
	// A requested signature check folds into the overall verdict: if you asked
	// for attestation and it failed, the citation is NOT verified.
	const verified = signature_check
		? coreVerified && signature_check.verified
		: coreVerified;
	const replay_hint = replayHintFor(checks, drift !== undefined);
	const payload: Record<string, unknown> = { verified };
	if (checks.result_check) {
		payload.expected_hash = checks.result_check.expected_hash;
		payload.actual_hash = checks.result_check.actual_hash;
	}
	if (checks.query_check) payload.query_check = checks.query_check;
	if (drift) payload.drift = drift;
	if (signature_check) payload.signature_check = signature_check;
	if (replay_hint) payload.replay_hint = replay_hint;
	const textSummary =
		(verified ? "Verified." : "NOT verified.") +
		describeCheck("Result integrity", checks.result_check) +
		describeCheck("Query identity", checks.query_check) +
		describeDrift(drift) +
		describeSignature(signature_check);
	return { payload, verified, textSummary };
}

/** Build the (stateless) input schema. */
function buildSchema(): VerifyCitationSchema {
	return {
		expected_hash: z
			.string()
			.optional()
			.describe(
				"A previously-issued result_hash (hex sha256) to verify `data` against — " +
					"e.g. Citation.result_hash.",
			),
		data: z
			.unknown()
			.optional()
			.describe(
				"The (claimed) underlying result data to re-hash. Any JSON value; " +
					"key order does not matter (canonicalized before hashing).",
			),
		query_hash: z
			.string()
			.optional()
			.describe(
				"A previously-issued query_hash (hex sha256) to verify `query` against — " +
					"e.g. Citation.query_hash. Enables the replay protocol.",
			),
		query: z
			.unknown()
			.optional()
			.describe(
				"The exact query to re-hash: for <prefix>_execute citations this is the raw " +
					"code STRING that was executed; for other tools, the args value.",
			),
		baseline: z
			.unknown()
			.optional()
			.describe(
				"Optional drift analysis: a previously-seen (originally-cited) result to diff " +
					"`data` against. For replay, pass the FRESH re-fetched result as `data` and the " +
					"originally-cited result as `baseline`; the response gains a `drift` summary " +
					"(added/removed/changed paths), the baseline's hash, and whether it matched " +
					"`expected_hash`.",
			),
		citation: z
			.unknown()
			.optional()
			.describe(
				"Attestation mode: the full Citation object (from a result's _meta.citation) " +
					"whose Ed25519 signature should be verified. Pair with `public_jwk`.",
			),
		public_jwk: z
			.unknown()
			.optional()
			.describe(
				"Attestation mode: the issuing server's public JWK (one entry from its " +
					"/.well-known/jwks.json, matching the citation signature's key_id) to verify " +
					"the signature against — offline, no trust in the transport.",
			),
	};
}

async function handle(input: VerifyCitationInput) {
	const checks = await runChecks(input);
	const signature_check = await runSignatureCheck(input);
	if (!checks.result_check && !checks.query_check && !signature_check) {
		return createCodeModeError(
			ErrorCodes.INVALID_ARGUMENTS,
			"Provide at least one of: { expected_hash, data } (result integrity), " +
				"{ query_hash, query } (query identity / replay), or { citation, public_jwk } " +
				"(signature verification).",
		);
	}
	const drift = await computeDrift(input);
	const { payload, textSummary } = buildPayload(checks, drift, signature_check);
	return createCodeModeResponse(payload, { textSummary });
}

/**
 * Servers that explicitly opt into the compatibility verifier.
 *
 * The MCP SDK throws `Tool <name> is already registered` on a duplicate name.
 * Registration is idempotent for callers that compose setup functions. Keyed
 * by server identity — `McpServer` instances are per-session, so finished
 * sessions drop out of the WeakSet.
 */
const REGISTERED = new WeakSet<object>();

/**
 * Register `verify_citation` (+ its `mcp_` alias) on a server exactly once.
 *
 * Normal Bio MCP servers do not register this tool. Consumers should verify
 * `_meta.citation` deterministically as they receive results; this optional MCP
 * surface remains for third-party clients that cannot run the shared verifier
 * locally. Both aliases are required by the fleet registration contract.
 *
 * @returns true when this call performed the registration, false when the
 *   server already had the tool.
 */
export function registerVerifyCitationOnce(server: {
	tool: (...args: unknown[]) => void;
}): boolean {
	if (REGISTERED.has(server)) return false;
	REGISTERED.add(server);
	const schema = buildSchema();
	// Return handle()'s promise directly (no async wrapper) — the MCP SDK
	// awaits the handler, so the promise is consumed, not floating.
	const toolHandler = (input: VerifyCitationInput) => handle(input);
	server.tool(`mcp_${TOOL_NAME}`, DESCRIPTION, schema, toolHandler);
	server.tool(TOOL_NAME, DESCRIPTION, schema, toolHandler);
	return true;
}

/**
 * Create a registerable `verify_citation` tool.
 *
 * Input: any of `{ expected_hash + data }` (result integrity) and/or
 * `{ query_hash + query }` (query identity / replay). At least one pair.
 *
 * `register()` delegates to {@link registerVerifyCitationOnce}, so repeated
 * setup calls on the same server are safe.
 */
export function createVerifyCitationTool(): VerifyCitationToolResult {
	return {
		name: TOOL_NAME,
		description: DESCRIPTION,
		schema: buildSchema(),
		register(server: { tool: (...args: unknown[]) => void }) {
			registerVerifyCitationOnce(server);
		},
	};
}
