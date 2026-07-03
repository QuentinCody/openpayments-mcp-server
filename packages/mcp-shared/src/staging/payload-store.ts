/**
 * Raw-payload fallback store (T5.3 — staging must never hard-fail to zero).
 *
 * When schema inference or materialization throws — e.g. a SQLite limit such as
 * "too many columns" on a CREATE TABLE — the staging DO must NOT return
 * `success:false` with no data. Instead it stores the whole response as a
 * chunked JSON blob in a `payloads` table that callers can still query (and the
 * chunking reader can re-assemble), preserving the bytes as an audit trail.
 *
 * Extracted from RestStagingDO.handleProcess so the no-array fallback and the
 * post-error fallback share one implementation and the DO file does not grow.
 */

import type { ChunkingEngine, SqlExec } from "./chunking";

export interface RawPayloadResult {
	tableCount: number;
	totalRows: number;
	tablesCreated: string[];
	/** Present only when this store was a fallback after a materialization error. */
	fallbackReason?: string;
}

/**
 * Stringify + store `data` as one chunked-JSON row in `payloads`, returning a
 * summary shaped like a normal staging response. Pure apart from the injected
 * `sql`/`chunking`, so it is unit-testable with an in-memory stub.
 */
export async function storeRawPayload(
	sql: SqlExec,
	chunking: Pick<ChunkingEngine, "smartJsonStringify">,
	data: unknown,
	fallbackReason?: string,
): Promise<RawPayloadResult> {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS payloads (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			root_json TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		)`,
	);
	const jsonStr = await chunking.smartJsonStringify(data, sql);
	sql.exec(`INSERT INTO payloads (root_json) VALUES (?)`, jsonStr);
	const row = sql.exec(`SELECT COUNT(*) as c FROM payloads`).one?.() as
		| { c: number }
		| undefined;
	return {
		tableCount: 1,
		totalRows: row?.c ?? 0,
		tablesCreated: ["payloads"],
		...(fallbackReason ? { fallbackReason } : {}),
	};
}
