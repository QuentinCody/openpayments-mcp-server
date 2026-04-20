import { describe, it, expect } from "vitest";
import {
	inferredSchemaToDdl,
	pragmaResultsToDdl,
	type InferredSchema,
} from "./schema-to-ddl";

describe("inferredSchemaToDdl", () => {
	it("generates DDL for a simple table", () => {
		const schema: InferredSchema = {
			tables: [
				{
					name: "variants",
					columns: [
						{ name: "gene", type: "TEXT" },
						{ name: "position", type: "INTEGER" },
						{ name: "score", type: "REAL" },
					],
					indexes: [],
				},
			],
		};
		const ddl = inferredSchemaToDdl(schema);
		expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "variants"');
		expect(ddl).toContain("id INTEGER PRIMARY KEY AUTOINCREMENT");
		expect(ddl).toContain('"gene" TEXT');
		expect(ddl).toContain('"position" INTEGER');
		expect(ddl).toContain('"score" REAL');
	});

	it("uses _rowid when table has an id column", () => {
		const schema: InferredSchema = {
			tables: [
				{
					name: "studies",
					columns: [
						{ name: "id", type: "TEXT" },
						{ name: "title", type: "TEXT" },
					],
					indexes: [],
				},
			],
		};
		const ddl = inferredSchemaToDdl(schema);
		expect(ddl).toContain("_rowid INTEGER PRIMARY KEY AUTOINCREMENT");
		expect(ddl).not.toMatch(/\bid INTEGER PRIMARY KEY AUTOINCREMENT/);
	});

	it("maps JSON type to TEXT", () => {
		const schema: InferredSchema = {
			tables: [
				{
					name: "data",
					columns: [{ name: "metadata", type: "JSON" }],
					indexes: [],
				},
			],
		};
		const ddl = inferredSchemaToDdl(schema);
		expect(ddl).toContain('"metadata" TEXT');
		expect(ddl).not.toContain("JSON");
	});

	it("escapes double quotes in column names", () => {
		const schema: InferredSchema = {
			tables: [
				{
					name: "data",
					columns: [{ name: 'col"with"quotes', type: "TEXT" }],
					indexes: [],
				},
			],
		};
		const ddl = inferredSchemaToDdl(schema);
		expect(ddl).toContain('"col""with""quotes" TEXT');
	});

	it("escapes double quotes in table names", () => {
		const schema: InferredSchema = {
			tables: [
				{
					name: 'table"name',
					columns: [{ name: "a", type: "TEXT" }],
					indexes: [],
				},
			],
		};
		const ddl = inferredSchemaToDdl(schema);
		expect(ddl).toContain('"table""name"');
	});

	it("handles reserved word column names", () => {
		const schema: InferredSchema = {
			tables: [
				{
					name: "results",
					columns: [
						{ name: "select", type: "TEXT" },
						{ name: "order", type: "INTEGER" },
						{ name: "group", type: "TEXT" },
					],
					indexes: [],
				},
			],
		};
		const ddl = inferredSchemaToDdl(schema);
		expect(ddl).toContain('"select" TEXT');
		expect(ddl).toContain('"order" INTEGER');
		expect(ddl).toContain('"group" TEXT');
	});

	it("handles multiple tables", () => {
		const schema: InferredSchema = {
			tables: [
				{
					name: "parent",
					columns: [{ name: "name", type: "TEXT" }],
					indexes: [],
				},
				{
					name: "child",
					columns: [{ name: "parent_id", type: "INTEGER" }],
					indexes: [],
					childOf: {
						parentTable: "parent",
						fkColumn: "parent_id",
						sourceColumn: "items",
					},
				},
			],
		};
		const ddl = inferredSchemaToDdl(schema);
		expect(ddl).toContain('"parent"');
		expect(ddl).toContain('"child"');
		expect(ddl.split("CREATE TABLE")).toHaveLength(3); // 1 empty + 2 tables
	});

	it("handles empty schema", () => {
		const ddl = inferredSchemaToDdl({ tables: [] });
		expect(ddl).toBe("");
	});

	it("handles table with no columns", () => {
		const schema: InferredSchema = {
			tables: [{ name: "empty", columns: [], indexes: [] }],
		};
		const ddl = inferredSchemaToDdl(schema);
		expect(ddl).toContain("id INTEGER PRIMARY KEY AUTOINCREMENT");
	});
});

describe("pragmaResultsToDdl", () => {
	it("generates DDL from PRAGMA table_info results", () => {
		const ddl = pragmaResultsToDdl([
			{
				name: "studies",
				columns: [
					{ name: "id", type: "INTEGER", pk: 1 },
					{ name: "title", type: "TEXT", pk: 0 },
					{ name: "status", type: "TEXT", pk: 0 },
				],
			},
		]);
		expect(ddl).toContain('"id" INTEGER PRIMARY KEY');
		expect(ddl).toContain('"title" TEXT');
		expect(ddl).toContain('"status" TEXT');
	});

	it("defaults missing type to TEXT", () => {
		const ddl = pragmaResultsToDdl([
			{
				name: "data",
				columns: [{ name: "value", type: "", pk: 0 }],
			},
		]);
		expect(ddl).toContain('"value" TEXT');
	});
});
