import { canonicalJson, sha256Hex } from "../provenance/provenance";

export const MCP_INLINE_LIMIT_BYTES = 100_000;
export const LOSSLESS_STAGE_THRESHOLD_BYTES = 30 * 1024;

export type LosslessStorage =
	| "server_staging"
	| "workspace"
	| "trace_chunks";

/** A compact transport envelope whose referenced payload is preserved in full. */
export interface LosslessEvidenceReference {
	lossless: true;
	storage: LosslessStorage;
	handle: string;
	content_hash: string;
	byte_length: number;
	query_tool?: string;
	schema_tool?: string;
	evidence_table?: string;
	complete: true;
}

export function serializedBytes(value: unknown): number {
	return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export async function buildLosslessReference(input: {
	storage: LosslessStorage;
	handle: string;
	payload: unknown;
	queryTool?: string;
	schemaTool?: string;
	evidenceTable?: string;
}): Promise<LosslessEvidenceReference> {
	const canonical = canonicalJson(input.payload);
	return {
		lossless: true,
		storage: input.storage,
		handle: input.handle,
		content_hash: `sha256:${await sha256Hex(canonical)}`,
		byte_length: new TextEncoder().encode(canonical).byteLength,
		...(input.queryTool ? { query_tool: input.queryTool } : {}),
		...(input.schemaTool ? { schema_tool: input.schemaTool } : {}),
		...(input.evidenceTable ? { evidence_table: input.evidenceTable } : {}),
		complete: true,
	};
}

export function isLosslessEvidenceReference(
	value: unknown,
): value is LosslessEvidenceReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const r = value as Partial<LosslessEvidenceReference>;
	return (
		r.lossless === true &&
		r.complete === true &&
		typeof r.handle === "string" &&
		typeof r.content_hash === "string" &&
		typeof r.byte_length === "number"
	);
}

/**
 * Transport guard for code paths that cannot stage. It never returns a clipped
 * value: callers must either provide a durable reference or surface this error.
 */
export function assertInlineTransportSafe(
	value: unknown,
	reference?: LosslessEvidenceReference,
): void {
	if (serializedBytes(value) <= MCP_INLINE_LIMIT_BYTES) return;
	if (reference && isLosslessEvidenceReference(reference)) return;
	throw new Error(
		"LOSSLESS_STAGING_REQUIRED: response exceeds the MCP inline transport limit and no durable, hash-addressed evidence reference was supplied",
	);
}

