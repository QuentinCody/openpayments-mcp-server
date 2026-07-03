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
 * Registered under two names (`verify_citation` + `mcp_verify_citation`) to match
 * the repo's dual-registration convention for discoverability across clients.
 */

import { z } from "zod";
import { type VerifyResult, verifyResultHash } from "../provenance/provenance";
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
}

export interface VerifyCitationToolResult {
	/** Primary registered tool name. */
	name: string;
	/** Human/agent-readable description. */
	description: string;
	/** Zod input schema (raw shape passed to `server.tool`). */
	schema: VerifyCitationSchema;
	/** Register the tool (and its `mcp_` alias) on an MCP server. */
	register: (server: { tool: (...args: unknown[]) => void }) => void;
}

const TOOL_NAME = "verify_citation";
const ALIAS_NAME = "mcp_verify_citation";

const DESCRIPTION =
	"Re-check a citation's integrity anchors. Result integrity: pass " +
	"{ expected_hash: <Citation.result_hash>, data: <claimed data> } to confirm cited bytes " +
	"were not altered. Query identity / REPLAY: pass { query_hash: <Citation.query_hash>, " +
	"query: <the exact query> } to confirm a query IS the one cited — for <prefix>_execute " +
	"citations the query is the raw code STRING. To adjudicate a disagreement (e.g. another " +
	"agent's result looks wrong), verify query identity, re-run that exact code via " +
	"<prefix>_execute, then verify the fresh result against the cited result_hash — replay, " +
	"don't judge by plausibility. Returns { verified, expected_hash?, actual_hash?, query_check?, " +
	"replay_hint? }. A mismatch is a normal negative verdict (verified:false), not a tool error.";

interface VerifyCitationInput {
	expected_hash?: string;
	data?: unknown;
	query_hash?: string;
	query?: unknown;
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

function describeCheck(label: string, check: VerifyResult | undefined): string {
	if (!check) return "";
	return check.verified
		? ` ${label} verified (sha256:${check.actual_hash.slice(0, 12)}).`
		: ` ${label} MISMATCH: expected sha256:${check.expected_hash.slice(0, 12)}, got sha256:${check.actual_hash.slice(0, 12)}.`;
}

function replayHintFor(checks: CitationChecks): string | undefined {
	return checks.query_check?.verified && !checks.result_check
		? "Query identity confirmed — to finish adjudication, re-run this exact code via the " +
				"server's <prefix>_execute tool, then call verify_citation again with " +
				"{ expected_hash: <cited result_hash>, data: <fresh result> }."
		: undefined;
}

/**
 * Assemble the response payload. Back-compatible: when a result-integrity check
 * ran, its `expected_hash`/`actual_hash` stay at the TOP level (the original
 * single-pair contract). Query-identity adds `query_check` + a `replay_hint`.
 */
function buildPayload(checks: CitationChecks): {
	payload: Record<string, unknown>;
	verified: boolean;
	textSummary: string;
} {
	const present = [checks.result_check, checks.query_check].filter(
		(c): c is VerifyResult => c !== undefined,
	);
	const verified = present.every((c) => c.verified);
	const replay_hint = replayHintFor(checks);
	const payload: Record<string, unknown> = { verified };
	if (checks.result_check) {
		payload.expected_hash = checks.result_check.expected_hash;
		payload.actual_hash = checks.result_check.actual_hash;
	}
	if (checks.query_check) payload.query_check = checks.query_check;
	if (replay_hint) payload.replay_hint = replay_hint;
	const textSummary =
		(verified ? "Verified." : "NOT verified.") +
		describeCheck("Result integrity", checks.result_check) +
		describeCheck("Query identity", checks.query_check);
	return { payload, verified, textSummary };
}

/**
 * Create a registerable `verify_citation` tool.
 *
 * Input: any of `{ expected_hash + data }` (result integrity) and/or
 * `{ query_hash + query }` (query identity / replay). At least one pair.
 */
export function createVerifyCitationTool(): VerifyCitationToolResult {
	const schema: VerifyCitationSchema = {
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
	};

	async function handle(input: VerifyCitationInput) {
		const checks = await runChecks(input);
		if (!checks.result_check && !checks.query_check) {
			return createCodeModeError(
				ErrorCodes.INVALID_ARGUMENTS,
				"Provide at least one verification pair: { expected_hash, data } for result " +
					"integrity, or { query_hash, query } for query identity / replay.",
			);
		}
		const { payload, textSummary } = buildPayload(checks);
		return createCodeModeResponse(payload, { textSummary });
	}

	return {
		name: TOOL_NAME,
		description: DESCRIPTION,
		schema,
		register(server: { tool: (...args: unknown[]) => void }) {
			// Return handle()'s promise directly (no async wrapper) — the MCP SDK
			// awaits the handler, so the promise is consumed, not floating.
			const toolHandler = (input: VerifyCitationInput) => handle(input);
			for (const name of [TOOL_NAME, ALIAS_NAME]) {
				server.tool(name, DESCRIPTION, schema, toolHandler);
			}
		},
	};
}
