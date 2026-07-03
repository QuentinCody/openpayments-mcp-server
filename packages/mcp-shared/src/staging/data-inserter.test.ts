import { describe, expect, it } from "vitest";
import {
	insertData,
	mapEntityToSchema,
	trackEntityRelationships,
} from "./data-inserter";
import { inferEntityType } from "./entity-discovery";
import type { SqlExec, TableSchema } from "./types";

// Minimal SqlExec stub: returns the cursor shape callers expect, records nothing.
const noopSql = (): SqlExec =>
	({
		exec: () => ({ toArray: () => [], one: () => undefined }),
	}) as unknown as SqlExec;

const schemaOf = (columns: Record<string, string>): TableSchema =>
	({ columns }) as unknown as TableSchema;

const makeState = () => ({
	processedEntities: new Map<string, Map<unknown, number | string>>(),
	relationshipData: new Map<string, Set<string>>(),
	totalRows: 0,
	errors: [] as string[],
});

const mapTo = (
	obj: unknown,
	columns: Record<string, string>,
	state = makeState(),
) => mapEntityToSchema(obj, schemaOf(columns), state);

describe("insertData", () => {
	it("inserts a scalar fallback row and reports no errors", () => {
		const schemas: Record<string, TableSchema> = {
			scalar_data: schemaOf({ value: "TEXT" }),
		};
		const result = insertData("hello", schemas, noopSql());
		expect(result.errors).toEqual([]);
		expect(result.totalRows).toBeGreaterThanOrEqual(0);
	});
});

describe("mapEntityToSchema", () => {
	it("stores a primitive under the value column for non-object input", () => {
		expect(mapTo("scalar", { value: "TEXT" })).toEqual({ value: "scalar" });
		expect(mapTo(42, { value: "INTEGER" })).toEqual({ value: 42 });
	});

	it("maps a direct column match", () => {
		expect(mapTo({ name: "Alice" }, { name: "TEXT" })).toEqual({
			name: "Alice",
		});
	});

	it("coerces booleans to 0/1", () => {
		expect(mapTo({ active: true }, { active: "INTEGER" })).toEqual({
			active: 1,
		});
		expect(mapTo({ active: false }, { active: "INTEGER" })).toEqual({
			active: 0,
		});
	});

	it("serializes a nested object into a _json column", () => {
		expect(mapTo({ meta: { a: 1 } }, { meta_json: "TEXT" })).toEqual({
			meta_json: '{"a":1}',
		});
	});

	it("skips an AUTOINCREMENT id column", () => {
		expect(
			mapTo(
				{ id: 9, name: "x" },
				{ id: "INTEGER PRIMARY KEY AUTOINCREMENT", name: "TEXT" },
			),
		).toEqual({
			name: "x",
		});
	});

	it("resolves a foreign key from a nested entity's own id", () => {
		expect(
			mapTo({ author: { id: 42, name: "A" } }, { author_id: "INTEGER" }),
		).toEqual({ author_id: 42 });
	});

	it("resolves a foreign key from the processed-entity registry when present", () => {
		const state = makeState();
		const author = { id: 1, name: "A" };
		state.processedEntities.set("author", new Map([[author, 777]]));
		expect(
			mapEntityToSchema({ author }, schemaOf({ author_id: "INTEGER" }), state),
		).toEqual({
			author_id: 777,
		});
	});

	it("extracts a nested field via prefix_subfield", () => {
		expect(
			mapTo({ author: { name: "Carol" } }, { author_name: "TEXT" }),
		).toEqual({ author_name: "Carol" });
	});

	it("skips an array of entities (junction tables own them)", () => {
		expect(mapTo({ tags: [{ id: 1, name: "a" }] }, { tags: "TEXT" })).toEqual(
			{},
		);
	});

	it("skips a nested entity in a non-FK column (FK columns own them)", () => {
		expect(mapTo({ author: { id: 5, name: "x" } }, { author: "TEXT" })).toEqual(
			{},
		);
	});

	it("omits a column when no strategy resolves a value", () => {
		expect(mapTo({ other: "z" }, { missing: "TEXT" })).toEqual({});
	});

	it("T5.1/T5.3: fills _overflow_json with the full record on a capped table", () => {
		const record = { a: 1, b: "two", c: true };
		const out = mapTo(record, { a: "INTEGER", _overflow_json: "TEXT" });
		// The overflow blob preserves the whole record so no field is lost.
		expect(out._overflow_json).toBe(JSON.stringify(record));
		// Kept columns still resolve normally alongside the overflow blob.
		expect(out.a).toBe(1);
	});
});

describe("trackEntityRelationships", () => {
	const tag1 = { id: 1, name: "a" };
	const tag2 = { id: 2, name: "b" };
	const relatedType = inferEntityType(tag1, ["tags"]);
	const junction = ["article", relatedType].sort().join("_");
	const schemas: Record<string, TableSchema> = { [junction]: schemaOf({}) };

	// Related entities must already be inserted (Phase 1) for their DB ids to
	// resolve; register them in processedEntities the way insertAllEntities does.
	const stateWithTags = () => {
		const state = makeState();
		state.processedEntities.set(
			relatedType,
			new Map<unknown, number | string>([
				[tag1, 1],
				[tag2, 2],
			]),
		);
		return state;
	};

	it("records a junction pair for each related entity in an array", () => {
		const state = stateWithTags();
		trackEntityRelationships(
			{ tags: [tag1, tag2] },
			"article",
			10,
			schemas,
			state,
		);
		expect(state.relationshipData.get(junction)?.size).toBe(2);
	});

	it("unwraps GraphQL edges/nodes wrappers before tracking", () => {
		const state = stateWithTags();
		trackEntityRelationships(
			{ tags: { edges: [{ node: tag1 }, { node: tag2 }] } },
			"article",
			10,
			schemas,
			state,
		);
		expect(state.relationshipData.get(junction)?.size).toBe(2);
	});

	it("does nothing when no junction table schema exists", () => {
		const state = makeState();
		trackEntityRelationships({ tags: [tag1] }, "article", 10, {}, state);
		expect(state.relationshipData.size).toBe(0);
	});

	it("ignores non-entity items", () => {
		const state = makeState();
		trackEntityRelationships(
			{ tags: ["plain", "strings"] },
			"article",
			10,
			schemas,
			state,
		);
		expect(state.relationshipData.size).toBe(0);
	});
});
