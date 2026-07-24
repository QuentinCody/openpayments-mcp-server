import { hashCanonicalJson, isSha256 } from "./canonical";
import {
	CANONICALIZATION_PROFILE,
	CITATION_VERSION,
	HASH_ALGORITHM,
} from "./constants";
import {
	importCitationPublicKey,
	verifyCitationSignature,
} from "./signing";
import type {
	Citation,
	CitationMetricCounters,
	CitationTrustStore,
	CitationVerification,
	HashCheckStatus,
	QueryScope,
	ResultScope,
	SignatureCheckStatus,
} from "./types";

interface ResolvedValue {
	available: boolean;
	value?: unknown;
}

export interface VerifyCitationEnvelopeInput {
	citation: unknown;
	toolArguments: unknown;
	structuredContent: unknown;
	/** Full staged bytes, supplied only after a trusted materialization read. */
	materialized?: { value: unknown };
	trustStore?: CitationTrustStore;
}

export interface VerifyCitationEnvelopeResult {
	citation?: Citation;
	verification: CitationVerification;
	metrics: CitationMetricCounters;
}

/** Parse the pinned-key file without trusting its compile-time JSON shape. */
export function parseCitationTrustStore(
	value: unknown,
): CitationTrustStore | undefined {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) {
		return undefined;
	}
	const servers: CitationTrustStore["servers"] = {};
	for (const [server, rawIssuer] of Object.entries(value.servers)) {
		if (!isRecord(rawIssuer) || !Array.isArray(rawIssuer.keys)) return undefined;
		const keys = [];
		for (const rawKey of rawIssuer.keys) {
			if (
				!isRecord(rawKey) ||
				rawKey.kty !== "OKP" ||
				rawKey.crv !== "Ed25519" ||
				typeof rawKey.x !== "string" ||
				typeof rawKey.kid !== "string" ||
				rawKey.d !== undefined
			) {
				return undefined;
			}
			keys.push({
				kty: rawKey.kty,
				crv: rawKey.crv,
				x: rawKey.x,
				kid: rawKey.kid,
				...(typeof rawKey.use === "string" ? { use: rawKey.use } : {}),
				...(typeof rawKey.alg === "string" ? { alg: rawKey.alg } : {}),
				...(Array.isArray(rawKey.key_ops) &&
				rawKey.key_ops.every((operation) => typeof operation === "string")
					? { key_ops: rawKey.key_ops }
					: {}),
			});
		}
		servers[server] = {
			require_signature: rawIssuer.require_signature === true,
			keys,
		};
	}
	return { version: 1, servers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

const QUERY_SCOPES = new Set<QueryScope>([
	"tool_arguments",
	"tool_argument:code",
]);
const RESULT_SCOPES = new Set<ResultScope>([
	"structured_content:data",
	"structured_content:root_without_meta",
	"staged:full_result",
]);

/** Strict parser: a citation is either the declared version-one contract or malformed. */
export function parseCitation(value: unknown): Citation | undefined {
	if (!isRecord(value) || !isRecord(value.source)) return undefined;
	if (
		value.citation_version !== CITATION_VERSION ||
		value.hash_algorithm !== HASH_ALGORITHM ||
		value.canonicalization_profile !== CANONICALIZATION_PROFILE ||
		!QUERY_SCOPES.has(value.query_scope as QueryScope) ||
		!RESULT_SCOPES.has(value.result_scope as ResultScope) ||
		!isSha256(value.query_hash) ||
		!isSha256(value.result_hash) ||
		typeof value.source.id !== "string" ||
		typeof value.source.name !== "string" ||
		typeof value.server !== "string" ||
		typeof value.tool !== "string" ||
		typeof value.retrieved_at !== "string" ||
		typeof value.issuer_git_sha !== "string" ||
		typeof value.fleet_contract_version !== "string" ||
		typeof value.text !== "string"
	) {
		return undefined;
	}
	return value as unknown as Citation;
}

export function resolveQueryScope(
	scope: QueryScope,
	toolArguments: unknown,
): ResolvedValue {
	if (scope === "tool_arguments") {
		return { available: true, value: toolArguments };
	}
	if (
		isRecord(toolArguments) &&
		hasOwn(toolArguments, "code") &&
		typeof toolArguments.code === "string"
	) {
		return { available: true, value: toolArguments.code };
	}
	return { available: false };
}

export function resolveResultScope(
	scope: ResultScope,
	structuredContent: unknown,
	materialized?: { value: unknown },
): ResolvedValue {
	if (scope === "staged:full_result") {
		return materialized
			? { available: true, value: materialized.value }
			: { available: false };
	}
	if (!isRecord(structuredContent)) return { available: false };
	if (scope === "structured_content:data") {
		return hasOwn(structuredContent, "data")
			? { available: true, value: structuredContent.data }
			: { available: false };
	}
	const root = { ...structuredContent };
	delete root._meta;
	return { available: true, value: root };
}

interface HashCheck {
	status: HashCheckStatus;
	actualHash?: string;
}

async function checkHash(
	expected: string,
	resolved: ResolvedValue,
): Promise<HashCheck> {
	if (!resolved.available) return { status: "unavailable" };
	try {
		const actualHash = await hashCanonicalJson(resolved.value);
		return actualHash === expected
			? { status: "verified" }
			: { status: "mismatch", actualHash };
	} catch {
		return { status: "invalid" };
	}
}

async function checkSignature(
	citation: Citation,
	trustStore: CitationTrustStore | undefined,
): Promise<SignatureCheckStatus> {
	const servers = trustStore?.servers;
	const issuer =
		servers && hasOwn(servers, citation.server)
			? servers[citation.server]
			: undefined;
	if (!citation.signature) {
		return issuer?.require_signature ? "missing_required" : "unsigned";
	}
	const jwk = issuer?.keys.find(
		(key) => key.kid === citation.signature?.key_id,
	);
	if (!jwk) return "unknown_key";
	try {
		const publicKey = await importCitationPublicKey(jwk);
		const verdict = await verifyCitationSignature(citation, publicKey);
		if (verdict.verified) return "verified";
		return verdict.reason === "bad-signature"
			? "bad_signature"
			: "malformed";
	} catch {
		return "malformed";
	}
}

const SIGNATURE_FAILURES = new Set<SignatureCheckStatus>([
	"missing_required",
	"unknown_key",
	"bad_signature",
	"malformed",
]);

function metricsFor(
	citationPresent: boolean,
	verification: CitationVerification,
): CitationMetricCounters {
	return {
		citation_present: citationPresent ? 1 : 0,
		verified: verification.status === "verified" ? 1 : 0,
		staged_partial:
			verification.reason === "staged_result_not_materialized" ? 1 : 0,
		malformed: verification.reason === "malformed_citation" ? 1 : 0,
		mismatch: verification.reason === "hash_mismatch" ? 1 : 0,
		signature_failure:
			verification.reason === "signature_failure" ? 1 : 0,
	};
}

function malformedResult(): VerifyCitationEnvelopeResult {
	const verification: CitationVerification = {
		status: "failed",
		result: "invalid",
		query: "invalid",
		signature: "malformed",
		quarantined: true,
		reason: "malformed_citation",
	};
	return {
		verification,
		metrics: metricsFor(true, verification),
	};
}

/**
 * Verify one citation using only its declared scopes. There are no fallback
 * candidates: an absent scoped value is either a staged partial or malformed.
 */
export async function verifyCitationEnvelope(
	input: VerifyCitationEnvelopeInput,
): Promise<VerifyCitationEnvelopeResult> {
	const citation = parseCitation(input.citation);
	if (!citation) return malformedResult();

	const [query, result, signature] = await Promise.all([
		checkHash(
			citation.query_hash,
			resolveQueryScope(citation.query_scope, input.toolArguments),
		),
		checkHash(
			citation.result_hash,
			resolveResultScope(
				citation.result_scope,
				input.structuredContent,
				input.materialized,
			),
		),
		checkSignature(citation, input.trustStore),
	]);

	let verification: CitationVerification;
	if (query.status === "mismatch" || result.status === "mismatch") {
		verification = {
			status: "failed",
			query: query.status,
			result: result.status,
			signature,
			quarantined: true,
			reason: "hash_mismatch",
			...(query.actualHash ? { actual_query_hash: query.actualHash } : {}),
			...(result.actualHash ? { actual_result_hash: result.actualHash } : {}),
		};
	} else if (
		query.status === "invalid" ||
		query.status === "unavailable" ||
		result.status === "invalid" ||
		(result.status === "unavailable" &&
			citation.result_scope !== "staged:full_result")
	) {
		verification = {
			status: "failed",
			query: query.status,
			result: result.status,
			signature,
			quarantined: true,
			reason: "malformed_citation",
		};
	} else if (SIGNATURE_FAILURES.has(signature)) {
		verification = {
			status: "failed",
			query: query.status,
			result: result.status,
			signature,
			quarantined: true,
			reason: "signature_failure",
		};
	} else if (result.status === "unavailable") {
		verification = {
			status: "partial",
			query: query.status,
			result: result.status,
			signature,
			quarantined: false,
			reason: "staged_result_not_materialized",
		};
	} else {
		verification = {
			status: "verified",
			query: query.status,
			result: result.status,
			signature,
			quarantined: false,
		};
	}

	return {
		citation,
		verification,
		metrics: metricsFor(true, verification),
	};
}

export function missingCitationMetrics(): CitationMetricCounters {
	return {
		citation_present: 0,
		verified: 0,
		staged_partial: 0,
		malformed: 0,
		mismatch: 0,
		signature_failure: 0,
	};
}
