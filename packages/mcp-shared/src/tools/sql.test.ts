import { describe, expect, it } from "vitest";
import type { ToolContext } from "../registry/types";
import { sqlTools } from "./sql";
import { MAX_SCRATCH_DO_BYTES } from "./sql-write-guard";

/** A DO already at the byte ceiling (hardening doc 02 §3). */
const atCeilingStorage = {
	// SAFETY: the write guard's size gate reads only `databaseSize`.
	databaseSize: MAX_SCRATCH_DO_BYTES,
} as unknown as SqlStorage;

// ctx.sql is a tagged template; rejoin on "?" to reconstruct the query.
// failOn throws an Error; throwOn throws a non-Error (covers the String(e) arm).
const makeCtx = (failOn?: RegExp, throwOn?: RegExp) => {
	const calls: string[] = [];
	const sql = <T>(strings: TemplateStringsArray, ...params: unknown[]): T[] => {
		const query = strings.join("?");
		calls.push(query);
		if (throwOn?.test(query)) throw "raw string failure";
		if (failOn?.test(query)) throw new Error("syntax error");
		return [{ ok: 1, params: params.length }] as T[];
	};
	return { ctx: { sql } as unknown as ToolContext, calls };
};

const tool = (name: string) => {
	const t = sqlTools.find((x) => x.name === name);
	if (!t) throw new Error(`missing tool ${name}`);
	return t;
};

describe("sql_query", () => {
	it("runs read-only statements", async () => {
		const { ctx } = makeCtx();
		expect(
			await tool("sql_query").handler({ query: "SELECT 1" } as never, ctx),
		).toEqual([{ ok: 1, params: 0 }]);
	});

	it("forwards parameters", async () => {
		const { ctx } = makeCtx();
		const result = (await tool("sql_query").handler(
			{ query: "SELECT * FROM t WHERE a = ?", params: ["x"] } as never,
			ctx,
		)) as Array<{ params: number }>;
		expect(result[0].params).toBe(1);
	});

	it("rejects non-read-only statements", async () => {
		const { ctx } = makeCtx();
		await expect(
			tool("sql_query").handler(
				{ query: "INSERT INTO t VALUES (1)" } as never,
				ctx,
			),
		).rejects.toThrow(/only allows SELECT/);
	});
});

describe("sql_exec", () => {
	it("executes allowed DDL/DML and wraps the result", async () => {
		const { ctx } = makeCtx();
		expect(
			await tool("sql_exec").handler(
				{ query: "CREATE TABLE t (a)" } as never,
				ctx,
			),
		).toEqual({
			success: true,
			result: [{ ok: 1, params: 0 }],
		});
	});

	it("blocks ATTACH/DETACH/LOAD_EXTENSION", async () => {
		const { ctx } = makeCtx();
		await expect(
			tool("sql_exec").handler(
				{ query: "ATTACH DATABASE 'x' AS y" } as never,
				ctx,
			),
		).rejects.toThrow(/not allowed/);
	});

	// Hardening doc 02 §3 — sql_exec stays write-by-design, but bounded.
	it("still executes a small CREATE TABLE + INSERT (write-by-design preserved)", async () => {
		const { ctx, calls } = makeCtx();
		await tool("sql_exec").handler({ query: "CREATE TABLE t (a)" } as never, ctx);
		await tool("sql_exec").handler(
			{ query: "INSERT INTO t VALUES (1)" } as never,
			ctx,
		);
		expect(calls).toContain("CREATE TABLE t (a)");
		expect(calls).toContain("INSERT INTO t VALUES (1)");
	});

	it("rejects a WITH RECURSIVE without a LIMIT, without executing it", async () => {
		const { ctx, calls } = makeCtx();
		await expect(
			tool("sql_exec").handler(
				{
					query:
						"CREATE TABLE t AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c",
				} as never,
				ctx,
			),
		).rejects.toThrow(/recursive CTE is unbounded/i);
		expect(calls.some((q) => q.includes("CREATE TABLE"))).toBe(false);
	});

	it("rejects a write when the DO is already at the size ceiling", async () => {
		const { ctx, calls } = makeCtx();
		const atCeiling: ToolContext = { ...ctx, sqlStorage: atCeilingStorage };
		await expect(
			tool("sql_exec").handler(
				{ query: "CREATE TABLE t (a)" } as never,
				atCeiling,
			),
		).rejects.toThrow(/ceiling/);
		expect(calls).toEqual([]);
	});
});

describe("sql_exec_batch", () => {
	it("runs statements sequentially and reports per-statement outcomes", async () => {
		const { ctx, calls } = makeCtx(/UPDATE/); // make the UPDATE statement throw
		const result = (await tool("sql_exec_batch").handler(
			{
				statements: [
					{ query: "CREATE TABLE t (a)" },
					{ query: "ATTACH DATABASE 'x' AS y" }, // blocked, never executed
					{ query: "UPDATE t SET a = 1" }, // throws → caught
				],
			} as never,
			ctx,
		)) as {
			total: number;
			succeeded: number;
			failed: number;
			results: Array<{ success: boolean; error?: string }>;
		};

		expect(result.total).toBe(3);
		expect(result.succeeded).toBe(1);
		expect(result.failed).toBe(2);
		expect(result.results[0]).toMatchObject({ index: 0, success: true });
		expect(result.results[1]).toMatchObject({
			index: 1,
			success: false,
			error: expect.stringMatching(/not allowed/),
		});
		expect(result.results[2]).toMatchObject({
			index: 2,
			success: false,
			error: "syntax error",
		});
		// the blocked statement never reached ctx.sql
		expect(calls.some((q) => q.includes("ATTACH"))).toBe(false);
	});

	it("stringifies non-Error throws from a statement", async () => {
		const { ctx } = makeCtx(undefined, /DELETE/);
		const result = (await tool("sql_exec_batch").handler(
			{ statements: [{ query: "DELETE FROM t" }] } as never,
			ctx,
		)) as { results: Array<{ error?: string }> };
		expect(result.results[0].error).toBe("raw string failure");
	});

	it("reports all-succeeded for a clean batch", async () => {
		const { ctx } = makeCtx();
		const result = (await tool("sql_exec_batch").handler(
			{
				statements: [
					{ query: "INSERT INTO t VALUES (1)" },
					{ query: "DELETE FROM t" },
				],
			} as never,
			ctx,
		)) as { succeeded: number; failed: number };
		expect(result).toMatchObject({ succeeded: 2, failed: 0 });
	});
});
