import { describe, expect, it } from "vitest";
import type { SqlExec } from "./chunking";
import { storeRawPayload } from "./payload-store";

// In-memory SQL stub: records payloads INSERTs and answers COUNT(*) from them.
const makeSql = () => {
	const inserts: unknown[] = [];
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			if (/insert\s+into\s+payloads/i.test(query)) inserts.push(bindings[0]);
			if (/count/i.test(query)) {
				const row = { c: inserts.length };
				return { toArray: () => [row], one: () => row };
			}
			return { toArray: () => [], one: () => undefined };
		},
	};
	return { sql: sql as unknown as SqlExec, inserts };
};

// Pass-through chunking stub — no real chunking needed for this unit.
const chunking = {
	async smartJsonStringify(obj: unknown) {
		return JSON.stringify(obj);
	},
};

describe("storeRawPayload (T5.3 fallback)", () => {
	it("creates the payloads table, stores the JSON, and reports one row", async () => {
		const { sql, inserts } = makeSql();
		const data = { items: [{ a: 1 }], note: "x" };

		const result = await storeRawPayload(sql, chunking, data);

		expect(result.tablesCreated).toEqual(["payloads"]);
		expect(result.tableCount).toBe(1);
		expect(result.totalRows).toBe(1);
		expect(result.fallbackReason).toBeUndefined();
		expect(inserts).toEqual([JSON.stringify(data)]);
	});

	it("carries the fallbackReason through when provided", async () => {
		const { sql } = makeSql();
		const result = await storeRawPayload(
			sql,
			chunking,
			{ x: 1 },
			"too many columns",
		);
		expect(result.fallbackReason).toBe("too many columns");
	});

	it("defaults totalRows to 0 when COUNT yields no row", async () => {
		const sql = {
			exec: () => ({ toArray: () => [], one: () => undefined }),
		} as unknown as SqlExec;
		const result = await storeRawPayload(sql, chunking, { x: 1 });
		expect(result.totalRows).toBe(0);
		expect(result.tablesCreated).toEqual(["payloads"]);
	});
});
