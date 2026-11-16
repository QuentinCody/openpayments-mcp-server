import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	detectArrays,
	type InferredSchema,
	inferSchema,
	materializeSchema,
	type SchemaHints,
} from "./schema-inference";

type Row = Record<string, unknown>;

const tableOf = (rows: unknown[], hints?: SchemaHints) =>
	inferSchema([{ key: "items", rows }], hints).tables;

const colOf = (table: { columns: Array<{ name: string }> }, name: string) =>
	table.columns.find((c) => c.name === name);

/** A node:sqlite DB behind the DO `exec(query, ...bindings)` surface. An optional
 *  `reject` predicate makes chosen INSERTs throw, as a constraint failure would. */
function openSql(reject?: (query: string, bindings: unknown[]) => boolean) {
	const db = new DatabaseSync(":memory:");
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			if (reject?.(query, bindings)) throw new Error("rejected");
			const stmt = db.prepare(query);
			if (/^\s*(select|with|pragma)/i.test(query)) {
				const rows = stmt.all(...(bindings as never[]));
				return { toArray: () => rows, one: () => rows[0] };
			}
			stmt.run(...(bindings as never[]));
			return { toArray: () => [], one: () => undefined };
		},
	};
	const all = (query: string) => sql.exec(query).toArray() as Row[];
	return { sql, all };
}

/** detectArrays → inferSchema → materializeSchema into a fresh in-memory DB. */
function stage(
	data: unknown,
	hints?: SchemaHints,
	reject?: (query: string, bindings: unknown[]) => boolean,
) {
	const { sql, all } = openSql(reject);
	const arrays = detectArrays(data);
	const schema = inferSchema(arrays, hints);
	const rows = new Map<string, unknown[]>();
	for (const t of schema.tables.filter((t) => !t.childOf)) {
		rows.set(t.name, arrays[0]?.rows ?? []);
	}
	const result = materializeSchema(schema, rows, sql, hints);
	return { schema, result, all };
}

describe("detectArrays — response envelopes", () => {
	it("treats a top-level array as the data table", () => {
		expect(detectArrays([{ a: 1 }])).toEqual([{ key: "data", rows: [{ a: 1 }] }]);
	});

	it("returns the non-empty arrays inside a HAL _embedded envelope", () => {
		const found = detectArrays({
			_embedded: { studies: [{ id: 1 }], associations: [] },
			_links: { self: "x" },
		});
		expect(found).toEqual([{ key: "studies", rows: [{ id: 1 }] }]);
	});

	it("falls back to top-level arrays when _embedded holds only empty arrays", () => {
		const found = detectArrays({ _embedded: { studies: [] }, page: [{ n: 1 }] });
		expect(found).toEqual([{ key: "page", rows: [{ n: 1 }] }]);
	});

	it("unwraps a single-key wrapper around an array", () => {
		expect(detectArrays({ genes: [{ s: "BRCA1" }] })).toEqual([
			{ key: "genes", rows: [{ s: "BRCA1" }] },
		]);
	});

	it("unwraps nested single-key GraphQL wrappers down to the array", () => {
		expect(detectArrays({ genes: { nodes: [{ s: "TP53" }] } })).toEqual([
			{ key: "nodes", rows: [{ s: "TP53" }] },
		]);
	});

	it("wraps a single-key object without arrays as a one-row table", () => {
		expect(detectArrays({ entry: { id: "1ABC", title: "t" } })).toEqual([
			{ key: "entry", rows: [{ id: "1ABC", title: "t" }] },
		]);
	});
});

describe("inferSchema — column classification", () => {
	it("types an all-null column as plain TEXT", () => {
		const [table] = tableOf([
			{ a: 1, note: null },
			{ a: 2, note: null },
		]);
		expect(colOf(table, "note")).toEqual({ name: "note", type: "TEXT" });
	});

	it("types a column of only empty arrays as pipe-delimited TEXT", () => {
		const [table] = tableOf([{ tags: [] }, { tags: [] }]);
		expect(colOf(table, "tags")).toEqual({ name: "tags", type: "TEXT", pipeDelimited: true });
	});

	it("ignores null items when it classifies scalar and object arrays", () => {
		const tables = tableOf([{ tags: [null, "a"], kids: [null, { sku: "x" }] }]);
		expect(colOf(tables[0], "tags")).toMatchObject({ type: "TEXT", pipeDelimited: true });
		expect(tables.map((t) => t.name)).toEqual(["items", "items_kids"]);
		expect(colOf(tables[1], "sku")).toEqual({ name: "sku", type: "TEXT" });
	});

	it("keeps an array of mixed objects and scalars as JSON with no shape and no child table", () => {
		const tables = tableOf([{ mixed: [1, { a: 1 }] }]);
		expect(tables).toHaveLength(1);
		expect(colOf(tables[0], "mixed")).toEqual({ name: "mixed", type: "JSON" });
	});

	it("gives a nested-object column a jsonShape that unions key types across rows", () => {
		const [table] = tableOf([
			{ a: { b: { c: { n: null, list: [1], s: "x", k: 2 } } } },
			{ a: { b: { c: { s: 5, extra: true } } } },
		]);
		expect(colOf(table, "a_b_c")).toEqual({
			name: "a_b_c",
			type: "JSON",
			jsonShape: "{n: null, list: array, s: string|number, k: number, extra: boolean}",
		});
	});

	it("discovers columns that first appear after the 100-row type sample", () => {
		const rows: unknown[] = Array.from({ length: 100 }, (_, i) => ({ a: i }));
		rows.push("not-an-object", { a: 1, late: 1.5, drop: "x" }, { late: 2.5 });
		const [table] = tableOf(rows, { exclude: ["drop"] });
		expect(table.columns).toEqual([
			{ name: "a", type: "INTEGER" },
			{ name: "late", type: "REAL" },
		]);
	});

	it("stores scalar rows in a single value column", () => {
		const { schema, result, all } = stage(["BRCA1", "TP53"]);
		expect(schema.tables[0].columns).toEqual([{ name: "value", type: "TEXT" }]);
		expect(result.totalRows).toBe(2);
		expect(all("SELECT value FROM data ORDER BY _rowid")).toEqual([
			{ value: "BRCA1" },
			{ value: "TP53" },
		]);
	});
});

/** Three parents with variant arrays and one with a non-array value (3/4 = the 75% bar). */
const VARIANT_ROWS = [
	{
		id: 1,
		variants: [
			{
				name: "V600E",
				parent_id: "upstream-7",
				tags: ["hotspot", "driver"],
				meta: { x: { y: 1 } },
				evidence: [{ evidence_id: 10, level: "A" }],
			},
		],
	},
	{ id: 2, variants: [{ name: "V600K", evidence: [{ evidence_id: 11, level: "B" }] }, "loose"] },
	{ id: 3, variants: [{ name: "K601E" }] },
	{ id: 4, variants: "n/a" },
];

describe("inferSchema — child and grandchild tables", () => {
	it("extracts a grandchild table from an object array inside child rows", () => {
		const tables = tableOf(VARIANT_ROWS);
		expect(tables.map((t) => t.name)).toEqual([
			"items",
			"items_variants",
			"items_variants_evidence",
		]);
		const child = tables[1];
		expect(child.columns).toEqual([
			{ name: "parent_id", type: "INTEGER" },
			{ name: "name", type: "TEXT" },
			{ name: "source_parent_id", type: "TEXT" },
			{ name: "tags", type: "TEXT", pipeDelimited: true },
			{ name: "meta_x", type: "JSON", jsonShape: "{y: number}" },
		]);
		expect(child.indexes).toEqual(["parent_id", "source_parent_id"]);
		expect(tables[2].childOf).toEqual({
			parentTable: "items_variants",
			fkColumn: "parent_id",
			sourceColumn: "evidence",
		});
		expect(tables[2].indexes).toEqual(["parent_id", "evidence_id"]);
	});

	it("keeps a grandchild array as a JSON column when it would exceed 100 columns", () => {
		const wide = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i]));
		const tables = tableOf([{ id: 1, kids: [{ name: "a", wide: [wide] }] }]);
		expect(tables.map((t) => t.name)).toEqual(["items", "items_kids"]);
		expect(colOf(tables[1], "wide")).toEqual({ name: "wide", type: "JSON" });
	});
});

describe("materializeSchema — child tables, overflow, indexes, failures", () => {
	it("links parent, child and grandchild rows through parent_id → _rowid", () => {
		const { result, all } = stage({ data: VARIANT_ROWS });
		expect(result.tablesCreated).toEqual(["data", "data_variants", "data_variants_evidence"]);
		expect(result.tableRowCounts).toEqual({
			data: 4,
			data_variants: 4,
			data_variants_evidence: 2,
		});
		expect(result.failedRows).toBe(0);
		const joined = all(
			`SELECT p.id, c.name, c.source_parent_id, c.tags, g.evidence_id, g.level
			 FROM data p
			 JOIN data_variants c ON c.parent_id = p._rowid
			 JOIN data_variants_evidence g ON g.parent_id = c._rowid
			 ORDER BY g.evidence_id`,
		);
		expect(joined).toEqual([
			{ id: 1, name: "V600E", source_parent_id: "upstream-7", tags: "hotspot | driver", evidence_id: 10, level: "A" },
			{ id: 2, name: "V600K", source_parent_id: null, tags: null, evidence_id: 11, level: "B" },
		]);
		// The scalar "loose" item still yields a child row; it has no named fields.
		expect(all("SELECT name FROM data_variants WHERE parent_id = 2 ORDER BY _rowid")).toEqual([
			{ name: "V600K" },
			{ name: null },
		]);
	});

	it("writes the demoted keys of a wide row into one _overflow JSON value", () => {
		const wide = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`c${i}`, i]));
		const { all } = stage({ data: [wide, { c0: -1 }] });
		const [first, second] = all("SELECT c0, _overflow FROM data ORDER BY _rowid");
		const expected = Object.fromEntries(
			Array.from({ length: 11 }, (_, i) => [`c${199 + i}`, 199 + i]),
		);
		expect(JSON.parse(first._overflow as string)).toEqual(expected);
		expect(second).toEqual({ c0: -1, _overflow: null });
	});

	it("creates each hinted composite index under a name that joins its columns", () => {
		const { all } = stage(
			{ data: [{ gene_symbol: "BRCA1", chrom: "17" }] },
			{ compositeIndexes: [["gene_symbol", "chrom"]] },
		);
		const names = all("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").map(
			(r) => r.name,
		);
		expect(names).toContain("idx_data_gene_symbol_chrom");
		expect(all("PRAGMA index_info('idx_data_gene_symbol_chrom')").map((r) => r.name)).toEqual([
			"gene_symbol",
			"chrom",
		]);
	});

	it("records failed inserts as warnings and drops the children of a failed parent", () => {
		const reject = (query: string, bindings: unknown[]) =>
			query.startsWith("INSERT") && (bindings.includes("BAD") || bindings.includes("BADCHILD"));
		const { result, all } = stage(
			{
				data: [
					{ id: 1, name: "ok", kids: [{ k: "a" }, { k: "BADCHILD" }] },
					{ id: 2, name: "BAD", kids: [{ k: "b" }] },
				],
			},
			undefined,
			reject,
		);
		expect(result.totalRows).toBe(2);
		expect(result.failedRows).toBe(2);
		expect(result.warnings).toEqual([
			{ rowIndex: 1, table: "data", error: "rejected" },
			{ rowIndex: 1, table: "data_kids", error: "rejected" },
		]);
		expect(all("SELECT k FROM data_kids")).toEqual([{ k: "a" }]);
	});

	it("skips a child whose parent is unnamed and inserts nothing for a child with no source column", () => {
		const parentId = { name: "parent_id", type: "INTEGER" as const };
		const schema: InferredSchema = {
			tables: [
				{ name: "p", columns: [{ name: "id", type: "INTEGER" }], indexes: [] },
				{
					name: "orphan",
					columns: [parentId],
					indexes: [],
					childOf: { parentTable: "", fkColumn: "parent_id", sourceColumn: "kids" },
				},
				{
					name: "p_nosrc",
					columns: [parentId],
					indexes: [],
					childOf: { parentTable: "p", fkColumn: "parent_id", sourceColumn: "" },
				},
				{
					name: "p_kids",
					columns: [parentId, { name: "k", type: "TEXT" }],
					indexes: [],
					childOf: { parentTable: "p", fkColumn: "parent_id", sourceColumn: "kids" },
				},
				{
					name: "p_kids_nosrc",
					columns: [parentId],
					indexes: [],
					childOf: { parentTable: "p_kids", fkColumn: "parent_id", sourceColumn: "" },
				},
			],
		};
		// Each row also carries an object array under the empty key "", which the
		// no-source children must not pick up.
		const rows = new Map<string, unknown[]>([
			["p", [{ id: 1, kids: [{ k: "a", "": [{ z: 1 }] }], "": [{ z: 2 }] }]],
		]);
		const { sql, all } = openSql();
		const result = materializeSchema(schema, rows, sql);
		expect(result.tablesCreated).toEqual(["p", "p_nosrc", "p_kids", "p_kids_nosrc"]);
		expect(result.tableRowCounts).toEqual({ p: 1, p_kids: 1 });
		expect(all("SELECT name FROM sqlite_master WHERE name = 'orphan'")).toEqual([]);
		expect(all("SELECT COUNT(*) AS n FROM p_nosrc")).toEqual([{ n: 0 }]);
		expect(all("SELECT COUNT(*) AS n FROM p_kids_nosrc")).toEqual([{ n: 0 }]);
	});
});
