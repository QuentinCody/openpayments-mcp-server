/**
 * `/delete` must leave the DO in the state its constructor established.
 *
 * `ctx.storage.deleteAll()` drops the SQLite tables as well as the KV keys, and
 * that includes the internal bookkeeping tables (`_do_migrations`,
 * `_staging_metadata`, `_inferred_schema`, `_column_profiles`,
 * `_session_registry`). Those are created ONLY by `migrateMetadata()`, which
 * runs ONLY in the constructor — so before 2026-08-28 a `/delete` left the DO
 * alive but permanently broken for the rest of its instance lifetime: the next
 * `/process` reached `storeProvenance()` and died with
 * `no such table: _staging_metadata: SQLITE_ERROR`.
 *
 * Fleet symptom: `oig_sync_data` on the deployed oig-leie server returned
 * `STAGING_ERROR: Failed to stage exclusion data: no such table:
 * _staging_metadata` on every call, so the LEIE snapshot could never be
 * loaded and `oig_exclusion_check` had nothing to read.
 *
 * ~100 servers extend this class, so this is a fleet-wide invariant.
 */

import { describe, expect, it } from "vitest";
import { ChunkingEngine } from "./chunking";
import { RestStagingDO } from "./rest-staging-do";

/**
 * A SqlStorage double that models TABLE EXISTENCE, which is the whole point
 * here: a statement naming a table that has not been created throws exactly
 * the way SQLite does.
 */
function makeSql() {
	const tables = new Set<string>();
	const cursor = (rows: Record<string, unknown>[]) => ({
		toArray: () => rows,
		one: () => rows[0],
		next: () => ({ done: true as const }),
		rowsRead: rows.length,
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	});

	const sql = {
		exec(query: string, ..._bindings: unknown[]) {
			const created = query.match(
				/CREATE TABLE (?:IF NOT EXISTS )?([A-Za-z_][A-Za-z0-9_]*)/i,
			);
			if (created) {
				tables.add(created[1]);
				return cursor([]);
			}
			if (/CREATE (?:UNIQUE )?INDEX/i.test(query)) return cursor([]);

			for (const name of query.matchAll(
				/(?:FROM|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
			)) {
				if (!tables.has(name[1])) {
					throw new Error(`no such table: ${name[1]}: SQLITE_ERROR`);
				}
			}
			// The migration reads its own version counter.
			if (/COALESCE\(MAX\(id\), 0\)/i.test(query)) return cursor([{ v: 0 }]);
			return cursor([]);
		},
	};

	return { sql, tables };
}

function makeDo() {
	const { sql, tables } = makeSql();
	let deleteAllCalls = 0;
	// SAFETY: Object.create yields a real RestStagingDO prototype chain; the two
	// fields the constructor would set are supplied here. Running the real
	// constructor is not possible without a Workers runtime
	// (`blockConcurrencyWhile`), so the migration is invoked directly instead.
	const instance = Object.create(RestStagingDO.prototype) as RestStagingDO;
	const internals = instance as unknown as {
		ctx: { storage: { sql: typeof sql; deleteAll(): Promise<void> } };
		chunking: ChunkingEngine;
		migrateMetadata(): void;
	};
	internals.ctx = {
		storage: {
			sql,
			deleteAll: async () => {
				deleteAllCalls++;
				tables.clear(); // deleteAll drops SQLite tables, not just KV keys
			},
		},
	};
	internals.chunking = new ChunkingEngine();
	// Stand in for the constructor's blockConcurrencyWhile(migrateMetadata).
	internals.migrateMetadata();
	return { instance, tables, deleteAllCalls: () => deleteAllCalls };
}

const del = () => new Request("http://do/delete", { method: "DELETE" });

describe("RestStagingDO /delete", () => {
	it("creates the bookkeeping tables on construction", () => {
		const { tables } = makeDo();
		expect(tables.has("_do_migrations")).toBe(true);
		expect(tables.has("_staging_metadata")).toBe(true);
	});

	it("re-creates the bookkeeping tables that deleteAll() dropped", async () => {
		const { instance, tables } = makeDo();

		const res = await instance.fetch(del());

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		// The regression: before the fix these were gone for good and the next
		// /process died at storeProvenance.
		expect(tables.has("_do_migrations")).toBe(true);
		expect(tables.has("_staging_metadata")).toBe(true);
	});

	it("leaves _staging_metadata writable after a delete", async () => {
		const { instance, tables } = makeDo();
		await instance.fetch(del());

		const internals = instance as unknown as {
			ctx: { storage: { sql: { exec(q: string): unknown } } };
		};
		// This is the exact statement storeProvenance() runs, and the exact one
		// that threw `no such table: _staging_metadata` in production.
		expect(() =>
			internals.ctx.storage.sql.exec(
				"INSERT INTO _staging_metadata (tool_name) VALUES ('probe')",
			),
		).not.toThrow();
		expect(tables.has("_staging_metadata")).toBe(true);
	});

	it("still drops the caller's staged data", async () => {
		const { instance, tables } = makeDo();
		tables.add("exclusions");

		await instance.fetch(del());

		expect(tables.has("exclusions")).toBe(false);
	});
});
