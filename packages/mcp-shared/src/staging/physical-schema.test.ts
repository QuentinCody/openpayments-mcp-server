import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withPhysicalTables } from "./physical-schema";

it("reads physical chunk columns without changing the inferred native table", () => {
	const db = new DatabaseSync(":memory:");
	try {
		for (const statement of ['CREATE TABLE records (CONTRACT_ID TEXT)', 'CREATE TABLE content_chunks (content_id TEXT, chunk_index INTEGER, chunk_data TEXT)', 'CREATE TABLE "quoted""name" (amount REAL)']) db.prepare(statement).run();
		const sql = { exec: (query: string) => ({ toArray: () => db.prepare(query).all() }) };
		const native = { name: "records", columns: [{ name: "CONTRACT_ID", type: "TEXT" as const }], indexes: [] };
		const result = withPhysicalTables({ tables: [native] }, sql);
		expect(result.tables[0]).toBe(native);
		expect(result.tables.slice(1)).toEqual([
			{ name: "content_chunks", columns: [{ name: "content_id", type: "TEXT" }, { name: "chunk_index", type: "INTEGER" }, { name: "chunk_data", type: "TEXT" }], indexes: [] },
			{ name: 'quoted"name', columns: [{ name: "amount", type: "REAL" }], indexes: [] },
		]);
	} finally { db.close(); }
});
