import { describe, expect, it } from "vitest";
import type { InferredSchema, TableProfile } from "./schema-inference";
import {
	buildColumnDescriptor,
	buildColumnMeta,
	buildProfileByTable,
	buildRelationshipJoins,
	normalizeProvenance,
} from "./schema-response";
import type { TableRelationship } from "./staging-metadata";

const schemaOf = (tables: unknown): InferredSchema => ({ tables }) as unknown as InferredSchema;
const rel = (over: Partial<TableRelationship>): TableRelationship =>
	({ parent_table: "parent", child_table: "child", fk_column: "parent_id", source_column: "kids", ...over }) as TableRelationship;

describe("buildColumnMeta", () => {
	it("returns an empty map for undefined schema", () => {
		expect(buildColumnMeta(undefined).size).toBe(0);
	});
	it("indexes only columns with json_shape or pipe-delimited hints", () => {
		const meta = buildColumnMeta(
			schemaOf([
				{
					name: "t",
					columns: [
						{ name: "a", jsonShape: "{x:number}" },
						{ name: "b", pipeDelimited: true },
						{ name: "c" },
					],
				},
			]),
		);
		expect(meta.get("t.a")).toEqual({ jsonShape: "{x:number}", pipeDelimited: undefined });
		expect(meta.get("t.b")).toEqual({ jsonShape: undefined, pipeDelimited: true });
		expect(meta.has("t.c")).toBe(false);
	});
});

describe("buildProfileByTable", () => {
	it("returns an empty map for undefined profiles", () => {
		expect(buildProfileByTable(undefined).size).toBe(0);
	});
	it("keys profiles by table name", () => {
		const profiles = [{ table: "t", columns: { a: { distinct: 3 } } }] as unknown as TableProfile[];
		expect(buildProfileByTable(profiles).get("t")).toEqual({ a: { distinct: 3 } });
	});
});

describe("buildColumnDescriptor", () => {
	const meta = buildColumnMeta(
		schemaOf([{ name: "t", columns: [{ name: "j", jsonShape: "{}" }, { name: "p", pipeDelimited: true }] }]),
	);
	const profiles = buildProfileByTable([{ table: "t", columns: { x: { n: 1 } } }] as unknown as TableProfile[]);

	it("maps PRAGMA flags and omits optional keys when absent", () => {
		const d = buildColumnDescriptor({ name: "plain", type: "TEXT", notnull: 0, pk: 0 }, "t", meta, profiles);
		expect(d).toEqual({ name: "plain", type: "TEXT", not_null: false, primary_key: false });
	});
	it("sets not_null / primary_key from the 1 sentinel", () => {
		const d = buildColumnDescriptor({ name: "id", type: "INTEGER", notnull: 1, pk: 1 }, "t", meta, profiles);
		expect(d.not_null).toBe(true);
		expect(d.primary_key).toBe(true);
	});
	it("attaches json_shape, searchable_array, and profile when present", () => {
		expect(buildColumnDescriptor({ name: "j", type: "TEXT", notnull: 0, pk: 0 }, "t", meta, profiles).json_shape).toBe("{}");
		expect(
			buildColumnDescriptor({ name: "p", type: "TEXT", notnull: 0, pk: 0 }, "t", meta, profiles).searchable_array,
		).toBe(true);
		expect(buildColumnDescriptor({ name: "x", type: "TEXT", notnull: 0, pk: 0 }, "t", meta, profiles).profile).toEqual({
			n: 1,
		});
	});
});

describe("buildRelationshipJoins", () => {
	it("uses p._rowid when the parent has its own data id column", () => {
		const schema = schemaOf([{ name: "parent", columns: [{ name: "id" }, { name: "label" }] }]);
		const [out] = buildRelationshipJoins([rel({})], schema);
		expect(out.join_sql).toBe(
			'SELECT p.*, c.* FROM "parent" p JOIN "child" c ON c.parent_id = p._rowid',
		);
		expect(out.parent_table).toBe("parent");
	});
	it("uses p.id when the parent has no data id column", () => {
		const schema = schemaOf([{ name: "parent", columns: [{ name: "label" }] }]);
		expect(buildRelationshipJoins([rel({})], schema)[0].join_sql).toContain("= p.id");
	});
	it("defaults to p.id when the parent table is absent from the schema", () => {
		expect(buildRelationshipJoins([rel({})], undefined)[0].join_sql).toContain("= p.id");
		expect(buildRelationshipJoins([], undefined)).toEqual([]);
	});
});

describe("normalizeProvenance", () => {
	it("returns undefined for a missing row", () => {
		expect(normalizeProvenance(undefined)).toBe(undefined);
	});
	it("keeps well-typed string/number fields and nulls the rest", () => {
		expect(
			normalizeProvenance({
				tool_name: "faers_search",
				server_name: "faers",
				api_url: "https://x",
				staged_at: "2026-01-01",
				input_rows: 100,
				stored_rows: 98,
				failed_rows: 2,
			}),
		).toEqual({
			tool_name: "faers_search",
			server_name: "faers",
			api_url: "https://x",
			staged_at: "2026-01-01",
			input_rows: 100,
			stored_rows: 98,
			failed_rows: 2,
		});
	});
	it("coerces wrong-typed fields to null", () => {
		expect(normalizeProvenance({ tool_name: 42, input_rows: "nope" })).toEqual({
			tool_name: null,
			server_name: null,
			api_url: null,
			staged_at: null,
			input_rows: null,
			stored_rows: null,
			failed_rows: null,
		});
	});
});
