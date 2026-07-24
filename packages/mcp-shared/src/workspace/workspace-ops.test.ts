import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MAX_RESULT_ROWS } from "../staging/sql-guard";
import {
	clearWorkspace,
	prefixSchema,
	queryWorkspace,
	stageDataset,
	workspaceSchema,
} from "./workspace-ops";

/**
 * Adapter that presents a node:sqlite in-memory DB through the same
 * `exec(query, ...bindings) -> { toArray(), one() }` surface that Cloudflare's
 * DO `ctx.storage.sql` exposes, so the ops run against real SQLite in tests.
 */
function makeSql() {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			if (/^\s*(select|with|pragma)/i.test(query)) {
				const rows = stmt.all(...(bindings as never[])) as Record<
					string,
					unknown
				>[];
				return {
					toArray: () => rows,
					// Match Cloudflare SqlStorage.one(): THROW unless exactly one row.
					// (A forgiving `rows[0]` here masked a real workerd bug — see git log.)
					one: () => {
						if (rows.length !== 1)
							throw new Error(
								`Expected exactly one result, got ${rows.length}`,
							);
						return rows[0];
					},
					[Symbol.iterator]: () => rows[Symbol.iterator](),
				};
			}
			stmt.run(...(bindings as never[]));
			const empty: Record<string, unknown>[] = [];
			return {
				toArray: () => empty,
				one: () => undefined,
				[Symbol.iterator]: () => empty[Symbol.iterator](),
			};
		},
	};
}

const chembl = {
	dataset: "chembl",
	data: {
		results: [
			{ symbol: "ABL1", action: "inhibitor" },
			{ symbol: "KIT", action: "inhibitor" },
		],
	},
	schemaHints: { tableName: "targets" },
	sourceTool: "chembl_execute",
};

const dgidb = {
	dataset: "dgidb",
	data: {
		results: [
			{ symbol: "ABL1", interaction_type: "inhibitor" },
			{ symbol: "FLT3", interaction_type: "inhibitor" },
		],
	},
	schemaHints: { tableName: "targets" },
	sourceTool: "dgidb_execute",
};

describe("prefixSchema", () => {
	it("prefixes table names and rewrites child-table FK parent refs", () => {
		const out = prefixSchema(
			{
				tables: [
					{ name: "study", columns: [], indexes: [] },
					{
						name: "arm",
						columns: [],
						indexes: [],
						childOf: {
							parentTable: "study",
							fkColumn: "parent_id",
							sourceColumn: "arms",
						},
					},
				],
			},
			"ctgov",
		);
		expect(out.tables[0].name).toBe("ctgov__study");
		expect(out.tables[1].name).toBe("ctgov__arm");
		expect(out.tables[1].childOf?.parentTable).toBe("ctgov__study");
	});
});

describe("stageDataset", () => {
	it("materializes a dataset into dataset__<table> tables and a manifest row", () => {
		const sql = makeSql();
		const handle = stageDataset(sql, chembl);
		expect(handle.dataset).toBe("chembl");
		expect(handle.tables).toContain("chembl__targets");
		expect(handle.evidence_table).toBe("chembl__evidence");
		expect(handle.row_count).toBe(2);
		expect(handle.completeness.complete).toBe(true);
		expect(handle.completeness.evidence_preserved).toBe(true);

		const rows = sql
			.exec("SELECT symbol, action FROM chembl__targets ORDER BY symbol")
			.toArray();
		expect(rows).toEqual([
			{ symbol: "ABL1", action: "inhibitor" },
			{ symbol: "KIT", action: "inhibitor" },
		]);
		const evidence = sql
			.exec("SELECT payload_json FROM chembl__evidence")
			.one();
		expect(evidence?.payload_json).toBe(JSON.stringify(chembl.data));
	});

	it("re-staging the same dataset replaces its old tables", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		stageDataset(sql, {
			...chembl,
			data: { results: [{ symbol: "EGFR", action: "inhibitor" }] },
		});
		const rows = sql.exec("SELECT symbol FROM chembl__targets").toArray();
		expect(rows).toEqual([{ symbol: "EGFR" }]);
	});
});

describe("stageDataset & queryWorkspace — branches and edge cases", () => {
	it("derives the table name from the array key when no tableName hint is given", () => {
		const sql = makeSql();
		const handle = stageDataset(sql, {
			dataset: "reactome",
			data: { items: [{ name: "Glycolysis" }] },
		});
		expect(handle.tables).toContain("reactome__items");
		expect(handle.row_count).toBe(1);
	});

	it("namespaces multiple arrays from one payload into separate tables", () => {
		const sql = makeSql();
		const handle = stageDataset(sql, {
			dataset: "multi",
			data: { genes: [{ name: "TP53" }], drugs: [{ name: "aspirin" }] },
		});
		expect(handle.tables.sort()).toEqual([
			"multi__drugs",
			"multi__evidence",
			"multi__genes",
		]);
		expect(sql.exec("SELECT name FROM multi__genes").toArray()).toEqual([
			{ name: "TP53" },
		]);
		expect(sql.exec("SELECT name FROM multi__drugs").toArray()).toEqual([
			{ name: "aspirin" },
		]);
	});

	it("populates primary_row_count from the top-level input length (== row_count for flat payloads)", () => {
		// chembl has 2 flat upstream records → primary_row_count 2, equal to row_count.
		const flat = stageDataset(makeSql(), chembl);
		expect(flat.primary_row_count).toBe(2);
		expect(flat.row_count).toBe(2);
		// Non-tabular JSON fallback stages exactly one primary row.
		expect(
			stageDataset(makeSql(), { dataset: "note", data: "scalar" })
				.primary_row_count,
		).toBe(1);
	});

	it("parks non-tabular data as a JSON payload row", () => {
		const sql = makeSql();
		const handle = stageDataset(sql, {
			dataset: "note",
			data: "just a scalar",
		});
		expect(handle.tables).toEqual(["note__payload", "note__evidence"]);
		expect(handle.evidence_table).toBe("note__evidence");
		expect(handle.row_count).toBe(1);
		const row = sql.exec(`SELECT root_json FROM "note__payload"`).one();
		expect(row?.root_json).toBe('"just a scalar"');
	});

	it("rejects a dataset name that sanitizes to empty", () => {
		const sql = makeSql();
		expect(() =>
			stageDataset(sql, { dataset: "***", data: { results: [] } }),
		).toThrow(/Invalid dataset/);
	});

	it("tolerates a corrupt manifest row (non-JSON tables/completeness)", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		sql.exec(
			"UPDATE _workspace_datasets SET tables_json = 'not-json', completeness = 'not-json' WHERE dataset = 'chembl'",
		);
		const schema = workspaceSchema(sql, "chembl");
		expect(schema.datasets[0].tables).toEqual([]);
		expect(schema.datasets[0].completeness).toBeNull();
	});

	it("returns a complete intentional view when the caller supplies LIMIT", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		const result = queryWorkspace(sql, {
			sql: "SELECT symbol FROM chembl__targets LIMIT 1",
		});
		expect(result.row_count).toBe(1);
		expect(result.complete_view).toBe(true);
	});
});

describe("queryWorkspace — the cross-server JOIN surface", () => {
	it("JOINs two independently-staged datasets in one SELECT", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		stageDataset(sql, dgidb);

		const result = queryWorkspace(sql, {
			sql: "SELECT c.symbol, c.action, d.interaction_type FROM chembl__targets c JOIN dgidb__targets d ON c.symbol = d.symbol",
		});
		expect(result.rows).toEqual([
			{ symbol: "ABL1", action: "inhibitor", interaction_type: "inhibitor" },
		]);
		expect(result.row_count).toBe(1);
	});

	it("rejects a result that exceeds the implicit bound without returning partial rows", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		expect(() =>
			queryWorkspace(sql, {
				sql: "SELECT symbol FROM chembl__targets",
				limit: 1,
			}),
		).toThrow(/LOSSLESS_QUERY_BOUND_REQUIRED.*No partial rows were returned/);
	});

	// `assertReadOnlySql` deliberately ALLOWS `PRAGMA table_info(<t>)` (T3.4), but
	// applyDefaultLimit then appended `LIMIT 100` to it — and PRAGMA takes no
	// LIMIT, so SQLite threw "near LIMIT: syntax error". The one describe the
	// guard lets through was the one statement that could never run.
	// Runs against real SQLite, so it reproduces the actual parser error.
	it("runs a PRAGMA table_info describe without appending a LIMIT", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);

		const result = queryWorkspace(sql, {
			sql: "PRAGMA table_info(chembl__targets)",
		});

		expect(result.sql).not.toMatch(/limit/i);
		expect(result.rows.length).toBeGreaterThan(0);
		expect(result.rows.map((r) => r.name)).toContain("symbol");
	});

	it("returns every column in a describe, even past the default page size", () => {
		const sql = makeSql();
		// 120 columns > the default limit of 100: the row-count heuristic would
		// otherwise read a complete describe as a truncated page.
		const cols = Array.from({ length: 120 }, (_, i) => `c${i}`);
		sql.exec(`CREATE TABLE wide__t (${cols.map((c) => `${c} TEXT`).join(", ")})`);

		const result = queryWorkspace(sql, { sql: "PRAGMA table_info(wide__t)" });

		expect(result.row_count).toBe(120);
		expect(result.complete_view).toBe(true);
	});

	it("rejects a write disguised as a query", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		expect(() =>
			queryWorkspace(sql, { sql: "DROP TABLE chembl__targets" }),
		).toThrow();
	});

	// Hardening doc 03 §1/§5 — the caller `limit` was taken verbatim with no
	// ceiling, so `limit: 10_000_000` emitted `LIMIT 10000000`.
	it("clamps an absurd caller limit to the hard ceiling", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);

		const result = queryWorkspace(sql, {
			sql: "SELECT symbol FROM chembl__targets",
			limit: 10_000_000,
		});

		expect(result.sql).toBe(
			`SELECT symbol FROM chembl__targets LIMIT ${MAX_RESULT_ROWS}`,
		);
		expect(result.row_count).toBeLessThanOrEqual(MAX_RESULT_ROWS);
	});

	it("rewrites an in-SQL LIMIT above the ceiling down to it", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);

		const result = queryWorkspace(sql, {
			sql: "SELECT symbol FROM chembl__targets LIMIT 999999",
		});

		expect(result.sql).toBe(
			`SELECT symbol FROM chembl__targets LIMIT ${MAX_RESULT_ROWS}`,
		);
	});

	it("rejects an oversized response in full and says why", () => {
		const sql = makeSql();
		// ~2 KB per row x 200 rows = ~400 KB, far past the ~96 KB ceiling.
		sql.exec("CREATE TABLE big__t (blob TEXT)");
		for (let i = 0; i < 200; i++) {
			sql.exec("INSERT INTO big__t (blob) VALUES (?)", "x".repeat(2000));
		}

		expect(() =>
			queryWorkspace(sql, { sql: "SELECT blob FROM big__t LIMIT 200" }),
		).toThrow(/LOSSLESS_QUERY_RESULT_TOO_LARGE.*No partial rows were returned/);
	});

	it("marks a small result as a complete view", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);

		const result = queryWorkspace(sql, {
			sql: "SELECT symbol FROM chembl__targets LIMIT 5",
		});

		expect(result.complete_view).toBe(true);
	});

	// Documents the REAL interaction of the two doc-03 ceilings, which is not
	// what the doc assumes. To ever reach MAX_RESULT_ROWS (10,000) a row must
	// serialize under 96 KB / 10,000 = 9.8 bytes. Even a minimal {"id":12345} is
	// 12 bytes, so the BYTE cap always binds first and the row cap is effectively
	// unreachable on this path. Both outcomes are explicit, which is what matters.
	it("rejects when the byte ceiling binds before the row ceiling", () => {
		const sql = makeSql();
		sql.exec("CREATE TABLE many__t (id INTEGER)");
		sql.exec(
			"INSERT INTO many__t(id) WITH RECURSIVE c(x) AS " +
				"(SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 10001) SELECT x FROM c",
		);

		expect(() =>
			queryWorkspace(sql, {
				sql: "SELECT id FROM many__t LIMIT 10000",
				limit: 10_000_000,
			}),
		).toThrow(/LOSSLESS_QUERY_RESULT_TOO_LARGE/);
	});
});

describe("workspaceSchema — the cross-server catalog", () => {
	it("lists every dataset with its tables and row counts", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		stageDataset(sql, dgidb);

		const schema = workspaceSchema(sql);
		expect(schema.dataset_count).toBe(2);
		const names = schema.datasets.map((d) => d.dataset).sort();
		expect(names).toEqual(["chembl", "dgidb"]);
		const chemblDs = schema.datasets.find((d) => d.dataset === "chembl");
		expect(chemblDs?.tables[0].name).toBe("chembl__targets");
		expect(chemblDs?.tables[0].row_count).toBe(2);
		expect(chemblDs?.tables[0].columns.map((c) => c.name)).toEqual(
			expect.arrayContaining(["symbol", "action"]),
		);
	});

	it("scopes to one dataset when asked", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		stageDataset(sql, dgidb);
		const schema = workspaceSchema(sql, "dgidb");
		expect(schema.dataset_count).toBe(1);
		expect(schema.datasets[0].dataset).toBe("dgidb");
	});
});

describe("clearWorkspace", () => {
	it("drops all dataset tables and empties the manifest", () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		stageDataset(sql, dgidb);
		clearWorkspace(sql);
		expect(workspaceSchema(sql).dataset_count).toBe(0);
		// GLOB (not LIKE) so `_` is literal — `_workspace_datasets` must NOT match.
		const tables = sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '*__*'",
			)
			.toArray();
		expect(tables).toEqual([]);
	});
});
