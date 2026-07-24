import { hashCanonicalJson, isSha256 } from "./canonical";
import {
	BUILD_GIT_SHA,
	CANONICALIZATION_PROFILE,
	CITATION_VERSION,
	FLEET_CONTRACT_VERSION,
	HASH_ALGORITHM,
} from "./constants";
import type {
	Citation,
	QueryScope,
	ResultScope,
	SourceDescriptor,
} from "./types";

export interface BuildCitationInput {
	source: SourceDescriptor;
	server: string;
	tool: string;
	query: unknown;
	queryScope: QueryScope;
	result: unknown;
	resultScope: ResultScope;
	retrievedAt: string;
	recordCount?: number;
	dataAccessId?: string;
	/** Use the full staged payload hash when those bytes are not inline. */
	resultHash?: string;
	issuerGitSha?: string;
	fleetContractVersion?: string;
}

function extractGuardInfo(
	result: unknown,
): { verified_empty?: boolean } | undefined {
	if (result === null || typeof result !== "object") return undefined;
	const direct = (result as { __guard?: unknown }).__guard;
	if (direct && typeof direct === "object") {
		return direct as { verified_empty?: boolean };
	}
	const nested = (result as { data?: { __guard?: unknown } }).data?.__guard;
	return nested && typeof nested === "object"
		? (nested as { verified_empty?: boolean })
		: undefined;
}

function classifyNegative(
	result: unknown,
	recordCount: number | undefined,
): { negative_result: true; verification: string } | undefined {
	if (extractGuardInfo(result)?.verified_empty === true) {
		return { negative_result: true, verification: "probe-certified-empty" };
	}
	return recordCount === 0
		? { negative_result: true, verification: "unverified-empty" }
		: undefined;
}

function formatCitation(
	input: BuildCitationInput,
	resultHash: string,
	verification?: string,
): string {
	const source = input.source.version
		? `${input.source.name} ${input.source.version}`
		: input.source.name;
	let text = `${source} — ${input.tool}, retrieved ${input.retrievedAt}`;
	if (typeof input.recordCount === "number") {
		text += `, ${input.recordCount} record${input.recordCount === 1 ? "" : "s"}`;
	}
	text += `, sha256:${resultHash.slice(0, 12)}`;
	if (verification === "probe-certified-empty") {
		text += ", NEGATIVE (probe-certified empty)";
	} else if (verification === "unverified-empty") {
		text += ", NEGATIVE (unverified empty — reconfirm before relying on it)";
	}
	if (input.source.url) text += ` (${input.source.url})`;
	return text;
}

export async function buildCitation(
	input: BuildCitationInput,
): Promise<Citation> {
	const queryHash = await hashCanonicalJson(input.query);
	if (input.resultHash !== undefined && !isSha256(input.resultHash)) {
		throw new TypeError("resultHash must be a lower-case SHA-256 hex digest");
	}
	const resultHash = input.resultHash ?? (await hashCanonicalJson(input.result));
	const negative = classifyNegative(input.result, input.recordCount);
	return {
		citation_version: CITATION_VERSION,
		hash_algorithm: HASH_ALGORITHM,
		canonicalization_profile: CANONICALIZATION_PROFILE,
		query_scope: input.queryScope,
		result_scope: input.resultScope,
		source: input.source,
		server: input.server,
		tool: input.tool,
		retrieved_at: input.retrievedAt,
		query_hash: queryHash,
		result_hash: resultHash,
		issuer_git_sha: input.issuerGitSha ?? BUILD_GIT_SHA,
		fleet_contract_version:
			input.fleetContractVersion ?? FLEET_CONTRACT_VERSION,
		...(input.recordCount !== undefined
			? { record_count: input.recordCount }
			: {}),
		...(input.dataAccessId !== undefined
			? { data_access_id: input.dataAccessId }
			: {}),
		...(negative ?? {}),
		text: formatCitation(input, resultHash, negative?.verification),
	};
}

export interface VerifyResult {
	verified: boolean;
	expected_hash: string;
	actual_hash: string;
}

export async function verifyResultHash(
	expectedHash: string,
	freshResult: unknown,
): Promise<VerifyResult> {
	const actualHash = await hashCanonicalJson(freshResult);
	return {
		verified: actualHash === expectedHash,
		expected_hash: expectedHash,
		actual_hash: actualHash,
	};
}

export async function verifyCitation(
	citation: Citation,
	freshResult: unknown,
): Promise<VerifyResult> {
	return verifyResultHash(citation.result_hash, freshResult);
}
