/**
 * Hardening doc 02 — read-only-by-default at the staging DO boundary.
 *
 * Drives the REAL `RestStagingDO.fetch` routes (`/query`, `/query-enhanced`)
 * against an in-memory SqlStorage double that RECORDS every statement it is
 * asked to run. That recording is the acceptance oracle: a blocked write must
 * never reach `sql.exec`, so no table can be created.
 *
 * 100+ servers extend this class, so these two routes are the fleet-wide choke
 * point for every legacy `<server>_query_sql` tool that POSTs raw caller SQL.
 */

import { describe, expect, it } from "vitest";
import { ChunkingEngine } from "./chunking";
import { RestStagingDO } from "./rest-staging-do";

/** The canonical attack from doc 02: fills a billable DO with a recursive CTE. */
const RECURSIVE_CREATE =
	"CREATE TABLE t AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c";

const ROWS: Record<string, unknown>[] = [
	{ drug: "imatinib" },
	{ drug: "dasatinib" },
];

/** The `SqlStorage.exec` surface the two query handlers actually use. */
interface SqlDouble {
	exec(query: string): {
		toArray(): Record<string, unknown>[];
		one(): Record<string, unknown> | undefined;
		next(): { done?: boolean; value?: Record<string, unknown> };
		rowsRead: number;
		[Symbol.iterator](): Iterator<Record<string, unknown>>;
	};
}

/** In-memory SqlStorage double that records every executed statement. */
function makeSql(): { sql: SqlDouble; executed: string[] } {
	const executed: string[] = [];
	const sql: SqlDouble = {
		exec(query: string) {
			executed.push(query);
			// No staged schema → getSchemaValidator() swallows this and returns
			// null, matching a DO whose dataset carries no inferred schema.
			if (/_inferred_schema/.test(query)) throw new Error("no such table");
			// The COUNT(*) wrapper wants a scalar; everything else wants the rows.
			const rows: Record<string, unknown>[] = /COUNT\(\*\)/.test(query)
				? [{ c: 2 }]
				: ROWS;
			// `next()` + `rowsRead` mirror the real SqlStorageCursor: doc 03's
			// bounded pull consumes the cursor incrementally rather than calling
			// toArray(), and reads rowsRead as it goes.
			let i = 0;
			return {
				toArray: () => rows,
				one: () => rows[0],
				next: () =>
					i < rows.length
						? { done: false as const, value: rows[i++] }
						: { done: true as const },
				get rowsRead() {
					return i;
				},
				[Symbol.iterator]: () => rows[Symbol.iterator](),
			};
		},
	};
	return { sql, executed };
}

/** The internals the fetch routes touch, supplied manually (see makeDo). */
interface DoInternals {
	ctx: { storage: { sql: SqlDouble } };
	chunking: ChunkingEngine;
}

/**
 * Build a RestStagingDO without running its constructor, which would call
 * `blockConcurrencyWhile` + `migrateMetadata`. The fetch routes are under test
 * here, not the migration.
 */
function makeDo(): { instance: RestStagingDO; executed: string[] } {
	const { sql, executed } = makeSql();
	// SAFETY: Object.create yields a real RestStagingDO prototype chain; the two
	// fields its constructor would have set (`ctx`, `chunking`) are assigned
	// below through DoInternals. `/query` + `/query-enhanced` read nothing else.
	const instance = Object.create(RestStagingDO.prototype) as RestStagingDO;
	// SAFETY: same object, viewed through the protected/private fields the
	// handlers use. The double implements the exact `exec` surface they call.
	const internals = instance as unknown as DoInternals;
	internals.ctx = { storage: { sql } };
	internals.chunking = new ChunkingEngine();
	return { instance, executed };
}

function post(path: string, body: unknown): Request {
	return new Request(`http://do${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe.each(["/query", "/query-enhanced"])("RestStagingDO %s", (path) => {
	it("rejects the recursive-CTE CREATE TABLE and never reaches sql.exec", async () => {
		const { instance, executed } = makeDo();

		const res = await instance.fetch(post(path, { sql: RECURSIVE_CREATE }));

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			success: false,
			error: expect.stringMatching(/CREATE/),
			code: "WRITE_SQL_BLOCKED",
		});
		// The acceptance bar: no statement ran, so no table was created.
		expect(executed).toEqual([]);
	});

	it.each([
		"DROP TABLE studies",
		"INSERT INTO studies (nct_id) VALUES ('x')",
		"UPDATE studies SET nct_id = 'x'",
		"DELETE FROM studies",
		"ALTER TABLE studies ADD COLUMN x TEXT",
		"SELECT 1; DROP TABLE studies",
	])("blocks %s without executing it", async (sql) => {
		const { instance, executed } = makeDo();

		const res = await instance.fetch(post(path, { sql }));

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			success: false,
			code: "WRITE_SQL_BLOCKED",
		});
		expect(executed).toEqual([]);
	});

	it("still returns rows for a legitimate SELECT", async () => {
		const { instance, executed } = makeDo();

		const res = await instance.fetch(
			post(path, { sql: "SELECT drug FROM interactions LIMIT 20" }),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, row_count: 2 });
		expect(executed).toContain("SELECT drug FROM interactions LIMIT 20");
	});

	it("still allows a WITH CTE and a PRAGMA table_info describe", async () => {
		for (const sql of [
			"WITH x AS (SELECT 1 AS n) SELECT n FROM x",
			"PRAGMA table_info(interactions)",
		]) {
			const { instance, executed } = makeDo();
			const res = await instance.fetch(post(path, { sql }));
			expect(res.status).toBe(200);
			expect(executed).toContain(sql);
		}
	});

	it("reports total_matching when count_total is requested", async () => {
		const { instance } = makeDo();

		const res = await instance.fetch(
			post(path, { sql: "SELECT drug FROM interactions", count_total: true }),
		);

		expect(await res.json()).toMatchObject({
			success: true,
			total_matching: 2,
			truncated: false,
		});
	});

	it("permits a write under the explicit allow_write opt-in (kill switch)", async () => {
		const { instance, executed } = makeDo();

		const res = await instance.fetch(
			post(path, { sql: "CREATE TABLE t (a)", allow_write: true }),
		);

		expect(res.status).toBe(200);
		expect(executed).toContain("CREATE TABLE t (a)");
	});
});

describe("RestStagingDO /process — payload-store fallback", () => {
	it("reports table_row_counts so the client can compute completeness (doc 10)", async () => {
		// Non-tabular data (no arrays to materialize) falls to the raw-JSON payload
		// store. That response used to omit table_row_counts, so the client's
		// pagination denominator was undefined and a partial slice read as complete.
		const { instance } = makeDo();
		const res = await instance.fetch(
			post("/process", { data: { scalar: "no arrays here" } }),
		);
		const body = (await res.json()) as {
			success: boolean;
			tables_created: string[];
			total_rows: number;
			table_row_counts?: Record<string, number>;
		};
		expect(body.success).toBe(true);
		expect(body.tables_created).toEqual(["payloads"]);
		// The fix: the per-table count is present and matches total_rows.
		expect(body.table_row_counts).toEqual({ payloads: body.total_rows });
	});
});
