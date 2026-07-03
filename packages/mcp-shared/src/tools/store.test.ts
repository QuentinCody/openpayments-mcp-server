import { describe, expect, it } from "vitest";
import type { ToolContext } from "../registry/types";
import { storeTools } from "./store";

// ctx.sql is a tagged template: reconstruct the query by re-joining on "?"
// (executeSql splits on "?" and passes params as template args).
type SqlCall = { query: string; params: unknown[] };
const makeCtx = (
	pragmaRows: Array<{ name: string; type: string }> = [],
	failOn?: RegExp,
) => {
	const calls: SqlCall[] = [];
	const sql = <T>(strings: TemplateStringsArray, ...params: unknown[]): T[] => {
		const query = strings.join("?");
		if (failOn?.test(query)) throw new Error("disk I/O error");
		calls.push({ query, params });
		if (query.startsWith("PRAGMA table_info")) return pragmaRows as T[];
		return [] as T[];
	};
	return { ctx: { sql } as unknown as ToolContext, calls };
};

const handler = storeTools[0].handler;
const run = (table: unknown, data: unknown, ctx: ToolContext) =>
	handler({ table, data } as never, ctx);

const errorCode = async (table: unknown, data: unknown) => {
	const { ctx } = makeCtx();
	const result = (await run(table, data, ctx)) as { error_code?: string };
	return result.error_code;
};

describe("__store table-name validation", () => {
	it("rejects empty, overlong, malformed, and reserved-prefix names", async () => {
		expect(await errorCode("", [{ a: 1 }])).toBe("INVALID_TABLE_NAME");
		expect(await errorCode("x".repeat(65), [{ a: 1 }])).toBe(
			"INVALID_TABLE_NAME",
		);
		expect(await errorCode("my table", [{ a: 1 }])).toBe("INVALID_TABLE_NAME");
		expect(await errorCode("sqlite_evil", [{ a: 1 }])).toBe(
			"INVALID_TABLE_NAME",
		);
		expect(await errorCode("_cf_kv", [{ a: 1 }])).toBe("INVALID_TABLE_NAME");
		// case-insensitive prefix match
		expect(await errorCode("SQLITE_master", [{ a: 1 }])).toBe(
			"INVALID_TABLE_NAME",
		);
	});
});

describe("__store data validation", () => {
	it("rejects non-arrays, empty arrays, and oversized payloads", async () => {
		expect(await errorCode("t", null)).toBe("INVALID_DATA");
		expect(await errorCode("t", [])).toBe("INVALID_DATA");
		const tooMany = Array.from({ length: 5001 }, () => ({ a: 1 }));
		expect(await errorCode("t", tooMany)).toBe("TOO_MANY_ROWS");
	});

	it("rejects rows that are not plain objects, with typed details", async () => {
		const { ctx } = makeCtx();
		const result = (await run("t", [{ a: 1 }, 42], ctx)) as {
			error_code: string;
			details: Array<{ row: number; value_type: string }>;
		};
		expect(result.error_code).toBe("INVALID_DATA");
		expect(result.details).toEqual([{ row: 1, value_type: "number" }]);
		expect(await errorCode("t", [null])).toBe("INVALID_DATA");
		expect(await errorCode("t", [[1]])).toBe("INVALID_DATA");
	});
});

describe("__store column/value validation (validateColumnsAndValues)", () => {
	it("rejects all-empty rows and too many columns", async () => {
		expect(await errorCode("t", [{}, {}])).toBe("NO_COLUMNS");
		const wide = [
			Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`c${i}`, 1])),
		];
		expect(await errorCode("t", wide)).toBe("TOO_MANY_COLUMNS");
	});

	it("rejects invalid column names", async () => {
		expect(await errorCode("t", [{ "bad-key": 1 }])).toBe(
			"INVALID_COLUMN_NAME",
		);
	});

	it("rejects nested values with per-key details and remediation hints", async () => {
		const { ctx } = makeCtx();
		const result = (await run("t", [{ a: { b: 1 }, tags: [1, 2] }], ctx)) as {
			error: string;
			error_code: string;
			hint: string;
			details: Array<{ row: number; key: string; value_type: string }>;
		};
		expect(result.error_code).toBe("NESTED_VALUES");
		expect(result.error).toContain("a, tags");
		expect(result.hint).toContain("JSON.stringify");
		expect(result.details).toEqual([
			{ row: 0, key: "a", value_type: "object" },
			{ row: 0, key: "tags", value_type: "array" },
		]);
	});
});

describe("__store happy paths", () => {
	it("creates a table with inferred types and batch-inserts rows", async () => {
		const { ctx, calls } = makeCtx();
		// score stays float in both rows: INTEGER/REAL disagreement would promote
		// to TEXT (any type mix promotes to TEXT, even numeric-only mixes).
		const data = [
			{ b: 2, a: "x", flag: true, score: 1.5, empty: null },
			{ b: "two", a: "y", flag: false, score: 2.5, empty: null },
		];
		const result = await run("t1", data, ctx);
		expect(result).toEqual({
			table: "t1",
			rows_inserted: 2,
			columns: ["a", "b", "empty", "flag", "score"],
			created: true,
		});

		const create = calls.find((c) => c.query.startsWith("CREATE TABLE"));
		expect(create?.query).toContain('"a" TEXT');
		expect(create?.query).toContain('"b" TEXT'); // mixed number/string promotes to TEXT
		expect(create?.query).toContain('"flag" INTEGER'); // booleans stored as 0/1
		expect(create?.query).toContain('"score" REAL');
		expect(create?.query).toContain('"empty" TEXT'); // all-null defaults to TEXT

		const insert = calls.find((c) => c.query.startsWith("INSERT INTO"));
		expect(insert?.query).toContain(
			'INSERT INTO "t1" ("a", "b", "empty", "flag", "score")',
		);
		expect(insert?.params).toEqual([
			"x",
			2,
			null,
			1,
			1.5,
			"y",
			"two",
			null,
			0,
			2.5,
		]);
	});

	it("evolves an existing table by adding only the new columns", async () => {
		const { ctx, calls } = makeCtx([{ name: "a", type: "TEXT" }]);
		const result = await run("t1", [{ a: "x", b: 1 }], ctx);
		expect(result).toEqual({
			table: "t1",
			rows_inserted: 1,
			columns: ["a", "b"],
			columns_added: ["b"],
		});
		expect(
			calls.some((c) => c.query === 'ALTER TABLE "t1" ADD COLUMN "b" INTEGER'),
		).toBe(true);
		expect(calls.some((c) => c.query.startsWith("CREATE TABLE"))).toBe(false);
	});

	it("skips DDL entirely when the schema already matches", async () => {
		const { ctx, calls } = makeCtx([
			{ name: "a", type: "TEXT" },
			{ name: "b", type: "INTEGER" },
		]);
		const result = (await run("t1", [{ a: "x", b: 1 }], ctx)) as Record<
			string,
			unknown
		>;
		expect(result.columns_added).toBeUndefined();
		expect(result.created).toBeUndefined();
		expect(
			calls.some(
				(c) => c.query.startsWith("ALTER") || c.query.startsWith("CREATE"),
			),
		).toBe(false);
	});

	it("splits inserts into batches of 500", async () => {
		const { ctx, calls } = makeCtx();
		const data = Array.from({ length: 501 }, (_, i) => ({ a: i }));
		const result = (await run("t1", data, ctx)) as { rows_inserted: number };
		expect(result.rows_inserted).toBe(501);
		expect(calls.filter((c) => c.query.startsWith("INSERT INTO")).length).toBe(
			2,
		);
	});

	it("wraps storage failures as STORE_ERROR", async () => {
		const { ctx } = makeCtx([], /CREATE TABLE/);
		expect(await run("t1", [{ a: 1 }], ctx)).toEqual({
			error: "disk I/O error",
			error_code: "STORE_ERROR",
		});
	});
});
