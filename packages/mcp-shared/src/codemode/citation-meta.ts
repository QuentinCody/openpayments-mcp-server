import {
	buildCitation,
	type Citation,
	type SourceDescriptor,
} from "../provenance/provenance";

export interface CodeModeCitationContext {
	source?: SourceDescriptor;
	server: string;
	tool: string;
	query: unknown;
}

/**
 * Normalize a staged payload hash into the bare lower-case sha256 hex a
 * {@link Citation}'s `result_hash` carries. Staging metadata writes it as
 * `sha256:<hex>`; anything else yields undefined, so a citation can never claim
 * the `staged:full_result` scope while holding a hash of some other bytes.
 */
export function canonicalPayloadHash(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const digest = value.startsWith("sha256:") ? value.slice(7) : value;
	return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

export function stagedPayloadHash(staging: unknown): unknown {
	if (
		staging === null ||
		typeof staging !== "object" ||
		Array.isArray(staging)
	) {
		return undefined;
	}
	return Reflect.get(staging, "payload_hash");
}

/**
 * Build a Code Mode citation. A staged response cites the preserved full
 * payload hash; otherwise it cites the inline structuredContent.data value.
 */
export async function buildCodeModeCitationMeta(
	context: CodeModeCitationContext | undefined,
	data: unknown,
	recordCount: number | undefined,
	dataAccessId: string | undefined,
	retrievedAt: string,
	payloadHash?: unknown,
): Promise<{ citation?: Citation }> {
	if (!context?.source) return {};
	const stagedHash = dataAccessId
		? canonicalPayloadHash(payloadHash)
		: undefined;
	const citation = await buildCitation({
		source: context.source,
		server: context.server,
		tool: context.tool,
		query: context.query,
		queryScope: "tool_argument:code",
		result: data,
		resultScope: stagedHash
			? "staged:full_result"
			: "structured_content:data",
		...(stagedHash ? { resultHash: stagedHash } : {}),
		retrievedAt,
		recordCount,
		dataAccessId,
	});
	return { citation };
}
