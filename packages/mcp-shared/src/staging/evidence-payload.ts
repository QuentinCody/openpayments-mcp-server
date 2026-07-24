/** Durable, complete-payload preservation independent of SQL inference. */
import { serializedBytes } from "../agentic/lossless";
import { canonicalJson, sha256Hex } from "../provenance/provenance";
import type { ChunkingEngine, SqlExec } from "./chunking";

export interface EvidencePayloadHandle {
	tableName: "evidence_payloads";
	payloadHash: string;
	payloadBytes: number;
}

/**
 * Store every source payload before attempting relational materialization.
 * Large scalar values may be represented by the ChunkingEngine, whose chunk
 * tables retain the complete bytes; payload_hash attests the canonical input.
 */
export async function storeEvidencePayload(
	sql: SqlExec,
	chunking: Pick<ChunkingEngine, "smartJsonStringify">,
	data: unknown,
): Promise<EvidencePayloadHandle> {
	const canonical = canonicalJson(data);
	const payloadHash = `sha256:${await sha256Hex(canonical)}`;
	const rootJson = await chunking.smartJsonStringify(data, sql);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS evidence_payloads (
			id INTEGER PRIMARY KEY,
			root_json TEXT NOT NULL,
			payload_hash TEXT NOT NULL,
			payload_bytes INTEGER NOT NULL,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		)`,
	);
	sql.exec(
		"INSERT OR REPLACE INTO evidence_payloads (id, root_json, payload_hash, payload_bytes) VALUES (1, ?, ?, ?)",
		rootJson,
		payloadHash,
		serializedBytes(data),
	);
	return {
		tableName: "evidence_payloads",
		payloadHash,
		payloadBytes: serializedBytes(data),
	};
}

