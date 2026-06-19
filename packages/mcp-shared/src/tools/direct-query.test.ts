import { describe, expect, it } from "vitest";
import type { ToolContext } from "../registry/types";
import {
	directQueryTools,
	ensureLimit,
	extractTableNames,
	isStrictReadOnly,
	redactRow,
	stripComments,
	validateTableAccess,
} from "./direct-query";

const makeCtx = (rows: Record<string, unknown>[] = [], failOn?: RegExp) => {
	const sql = <T,>(strings: TemplateStringsArray): T[] => {
		const query = strings.join("?");
		if (failOn?.test(query)) throw new Error("sql error");
		return rows as T[];
	};
	return { sql } as unknown as ToolContext;
};
const tool = (name: string) => {
	const t = directQueryTools.find((x) => x.name === name);
	if (!t) throw new Error(`missing ${name}`);
	return t;
};

describe("stripComments", () => {
	it("removes line and block comments and trims", () => {
		expect(stripComments("SELECT 1 -- trailing\n")).toBe("SELECT 1");
		expect(stripComments("SELECT /* mid */ 1")).toBe("SELECT  1");
	});
});

describe("isStrictReadOnly", () => {
	it("accepts SELECT and WITH", () => {
		expect(isStrictReadOnly("SELECT * FROM t")).toEqual({ valid: true });
		expect(isStrictReadOnly("WITH x AS (SELECT 1) SELECT * FROM x")).toEqual({ valid: true });
	});
	it.each([
		["empty", "   -- only a comment", "Empty query"],
		["multi-statement", "SELECT 1; SELECT 2", "Multi-statement queries are not allowed"],
		["non-select", "PRAGMA table_info(t)", "Query must start with SELECT or WITH"],
		["write keyword", "SELECT 1 FROM t WHERE x IN (DELETE FROM y)", "Query contains blocked keyword"],
	])("rejects %s", (_label, sql, error) => {
		expect(isStrictReadOnly(sql)).toEqual({ valid: false, error });
	});
});

describe("extractTableNames", () => {
	it("collects FROM/JOIN tables, including quoted and schema-qualified", () => {
		expect(extractTableNames("SELECT * FROM users u JOIN orders o ON o.uid = u.id")).toEqual(
			new Set(["users", "orders"]),
		);
		expect(extractTableNames('SELECT * FROM main."sqlite_master"')).toEqual(new Set(["main", "sqlite_master"]));
		expect(extractTableNames("SELECT 1")).toEqual(new Set());
	});
});

describe("validateTableAccess", () => {
	it("blocks denied tables and allows the rest", () => {
		expect(validateTableAccess(new Set(["users"]))).toEqual({ valid: true });
		expect(validateTableAccess(new Set(["users", "sqlite_master"]))).toEqual({
			valid: false,
			error: "Access denied to table: sqlite_master",
		});
		expect(validateTableAccess(new Set(["x"]), new Set(["x"]))).toMatchObject({ valid: false });
	});
});

describe("redactRow", () => {
	it("replaces sensitive columns with [REDACTED]", () => {
		expect(redactRow({ id: 1, session_token: "secret", name: "Ada" })).toEqual({
			id: 1,
			session_token: "[REDACTED]",
			name: "Ada",
		});
	});
});

describe("ensureLimit", () => {
	it("appends a LIMIT only when absent (respecting existing literal/parameterized limits)", () => {
		expect(ensureLimit("SELECT * FROM t", 500)).toBe("SELECT * FROM t LIMIT 501");
		expect(ensureLimit("SELECT * FROM t LIMIT 10")).toBe("SELECT * FROM t LIMIT 10");
		expect(ensureLimit("SELECT * FROM t LIMIT ?")).toBe("SELECT * FROM t LIMIT ?");
	});
});

describe("__query handler", () => {
	it("returns redacted rows with a count", async () => {
		const ctx = makeCtx([{ id: 1, session_token: "x" }]);
		expect(await tool("__query").handler({ sql: "SELECT * FROM users" } as never, ctx)).toEqual({
			rows: [{ id: 1, session_token: "[REDACTED]" }],
			count: 1,
			truncated: false,
		});
	});

	it("blocks non-read-only and denied-table queries", async () => {
		const ctx = makeCtx();
		expect(await tool("__query").handler({ sql: "DELETE FROM t" } as never, ctx)).toMatchObject({ error_code: "QUERY_BLOCKED" });
		expect(await tool("__query").handler({ sql: "SELECT * FROM sqlite_master" } as never, ctx)).toMatchObject({
			error: "Access denied to table: sqlite_master",
		});
	});

	it("flags truncation past 500 rows", async () => {
		const rows = Array.from({ length: 501 }, (_, i) => ({ i }));
		const result = (await tool("__query").handler({ sql: "SELECT * FROM t" } as never, makeCtx(rows))) as {
			count: number;
			truncated: boolean;
		};
		expect(result).toMatchObject({ count: 500, truncated: true });
	});

	it("rejects oversized results", async () => {
		const rows = Array.from({ length: 500 }, () => ({ blob: "x".repeat(2500) }));
		expect(await tool("__query").handler({ sql: "SELECT * FROM t" } as never, makeCtx(rows))).toMatchObject({
			error_code: "QUERY_TOO_LARGE",
		});
	});

	it("wraps execution errors", async () => {
		expect(
			await tool("__query").handler({ sql: "SELECT * FROM t" } as never, makeCtx([], /SELECT/)),
		).toEqual({ error: "sql error", error_code: "QUERY_ERROR" });
	});
});

describe("__query_batch handler", () => {
	it("rejects batches over the limit", async () => {
		const queries = Array.from({ length: 21 }, () => ({ sql: "SELECT 1" }));
		expect(await tool("__query_batch").handler({ queries } as never, makeCtx())).toMatchObject({
			error_code: "QUERY_BLOCKED",
		});
	});

	it("runs each query, collecting per-query outcomes", async () => {
		const ctx = makeCtx([{ a: 1, credential_hash: "h" }]);
		const result = (await tool("__query_batch").handler(
			{
				queries: [
					{ sql: "SELECT * FROM ok" },
					{ sql: "DROP TABLE t" }, // blocked
					{ sql: "SELECT * FROM sqlite_master" }, // denied table
				],
			} as never,
			ctx,
		)) as { results: unknown[] };
		expect(result.results[0]).toEqual([{ a: 1, credential_hash: "[REDACTED]" }]);
		expect(result.results[1]).toMatchObject({ error_code: "QUERY_BLOCKED" });
		expect(result.results[2]).toMatchObject({ error: "Access denied to table: sqlite_master" });
	});

	it("captures execution errors and truncation per query", async () => {
		const failResult = (await tool("__query_batch").handler(
			{ queries: [{ sql: "SELECT * FROM t" }] } as never,
			makeCtx([], /SELECT/),
		)) as { results: Array<{ error_code?: string }> };
		expect(failResult.results[0]).toMatchObject({ error_code: "QUERY_ERROR" });

		const rows = Array.from({ length: 501 }, (_, i) => ({ i }));
		const truncResult = (await tool("__query_batch").handler(
			{ queries: [{ sql: "SELECT * FROM t" }] } as never,
			makeCtx(rows),
		)) as { results: unknown[][] };
		expect(truncResult.results[0]).toHaveLength(500);
	});
});
