import { describe, expect, it } from "vitest";
import { inferSchema } from "./schema-inference";

const tableOf = (rows: unknown[], hints?: Parameters<typeof inferSchema>[1]) =>
	inferSchema([{ key: "items", rows }], hints).tables;

describe("inferSchema", () => {
	it("skips empty arrays and sanitizes table names", () => {
		expect(inferSchema([{ key: "items", rows: [] }]).tables).toEqual([]);
		const [table] = inferSchema([{ key: "My-Items!", rows: [{ a: 1 }] }]).tables;
		expect(table.name).toBe("my_items");
	});

	it("infers scalar column types and flattens nested objects", () => {
		const [table] = tableOf([{ name: "x", count: 2, ratio: 0.5, user: { name: "u" } }]);
		const byName = Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
		expect(byName.name).toBe("TEXT");
		expect(byName.count).toBe("INTEGER");
		expect(byName.ratio).toBe("REAL");
		expect(byName.user_name).toBe("TEXT");
	});

	it("emits one table per fixed tableName hint even with multiple arrays", () => {
		const result = inferSchema(
			[
				{ key: "alpha", rows: [{ a: 1 }] },
				{ key: "beta", rows: [{ b: 2 }] },
			],
			{ tableName: "fixed" },
		);
		expect(result.tables.map((t) => t.name)).toEqual(["fixed"]);
		expect(result.tables[0].columns.map((c) => c.name)).toEqual(["a"]);
	});

	it("honors exclude and columnTypes hints", () => {
		const [table] = tableOf([{ keep: "x", drop: "y" }], {
			exclude: ["drop"],
			columnTypes: { keep: "INTEGER" },
		});
		expect(table.columns).toEqual([{ name: "keep", type: "INTEGER" }]);
	});

	it("marks scalar-array columns as pipe-delimited TEXT", () => {
		const [table] = tableOf([{ tags: ["a", "b"] }, { tags: ["c"] }]);
		expect(table.columns[0]).toMatchObject({ name: "tags", type: "TEXT", pipeDelimited: true });
	});

	it("extracts object arrays into child tables with childOf metadata", () => {
		const tables = tableOf([
			{ id: 1, entries: [{ sku: "x", qty: 1 }] },
			{ id: 2, entries: [{ sku: "y", qty: 2 }] },
		]);
		expect(tables).toHaveLength(2);
		const child = tables[1];
		expect(child.childOf).toMatchObject({ parentTable: "items", fkColumn: "parent_id", sourceColumn: "entries" });
		// the source column no longer appears on the parent
		expect(tables[0].columns.some((c) => c.name === "entries")).toBe(false);
	});

	it("keeps a column as JSON when listed in skipChildTables", () => {
		const tables = tableOf(
			[
				{ id: 1, entries: [{ sku: "x" }] },
				{ id: 2, entries: [{ sku: "y" }] },
			],
			{ skipChildTables: ["entries"] },
		);
		expect(tables).toHaveLength(1);
		const entries = tables[0].columns.find((c) => c.name === "entries");
		expect(entries?.type).toBe("JSON");
	});

	it("keeps only composite indexes whose columns all exist", () => {
		const [table] = tableOf([{ a: 1, b: 2 }], { compositeIndexes: [["a", "b"], ["a", "missing"]] });
		expect(table.compositeIndexes).toEqual([["a", "b"]]);
	});

	it("auto-indexes identifier-like columns", () => {
		const [table] = tableOf([{ gene_id: "ENSG1", label: "x" }]);
		expect(table.indexes).toContain("gene_id");
	});

	it("caps wide tables by demoting extra columns into _overflow JSON", () => {
		// 210 columns -> 199 kept + _overflow; 11 demoted names, shape shows 5 + "+6 more"
		const wide = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`c${i}`, i]));
		const [table] = tableOf([wide]);
		expect(table.columns.length).toBe(200);
		const overflow = table.columns[table.columns.length - 1];
		expect(overflow.name).toBe("_overflow");
		expect(overflow.type).toBe("JSON");
		expect(overflow.jsonShape).toContain("c199");
		expect(overflow.jsonShape).toContain("+6 more");
	});
});
