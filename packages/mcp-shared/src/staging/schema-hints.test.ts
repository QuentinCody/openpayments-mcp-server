import { describe, expect, it } from "vitest";
import { deduplicateCompositeIndexes, mergeSchemaHints } from "./schema-hints";
import type { SchemaHints } from "./schema-inference";

const sh = (h: Partial<SchemaHints>): SchemaHints => h as SchemaHints;

describe("mergeSchemaHints", () => {
	it("returns undefined when both inputs are undefined", () => {
		expect(mergeSchemaHints(undefined, undefined)).toBeUndefined();
	});

	it("returns the present side verbatim when the other is undefined", () => {
		const server = sh({ tableName: "s" });
		const client = sh({ tableName: "c" });
		expect(mergeSchemaHints(server, undefined)).toBe(server);
		expect(mergeSchemaHints(undefined, client)).toBe(client);
	});

	it("lets client scalars win, falling back to server when the client omits them", () => {
		const merged = mergeSchemaHints(
			sh({ tableName: "s", maxRecursionDepth: 1 }),
			sh({ tableName: "c", maxRecursionDepth: 5 }),
		);
		expect(merged?.tableName).toBe("c");
		expect(merged?.maxRecursionDepth).toBe(5);

		const fallback = mergeSchemaHints(sh({ tableName: "s", maxRecursionDepth: 3 }), sh({ indexes: ["x"] }));
		expect(fallback?.tableName).toBe("s");
		expect(fallback?.maxRecursionDepth).toBe(3);
	});

	it("merges record hints with the client overriding per key", () => {
		const merged = mergeSchemaHints(
			sh({ columnTypes: { a: "TEXT", b: "INTEGER" } as SchemaHints["columnTypes"] }),
			sh({ columnTypes: { b: "REAL", c: "TEXT" } as SchemaHints["columnTypes"] }),
		);
		expect(merged?.columnTypes).toEqual({ a: "TEXT", b: "REAL", c: "TEXT" });
	});

	it("unions list hints with de-duplication", () => {
		const merged = mergeSchemaHints(
			sh({ indexes: ["a", "b"], exclude: ["x"] }),
			sh({ indexes: ["b", "c"], exclude: ["y"] }),
		);
		expect(merged?.indexes).toEqual(["a", "b", "c"]);
		expect(merged?.exclude).toEqual(["x", "y"]);
	});

	it("leaves a field undefined when neither side sets it", () => {
		const merged = mergeSchemaHints(sh({ tableName: "s" }), sh({ tableName: "c" }));
		expect(merged?.indexes).toBeUndefined();
		expect(merged?.columnTypes).toBeUndefined();
	});

	it("de-duplicates composite indexes across both sides", () => {
		const merged = mergeSchemaHints(
			sh({ compositeIndexes: [["a", "b"]] }),
			sh({ compositeIndexes: [["a", "b"], ["c"]] }),
		);
		expect(merged?.compositeIndexes).toEqual([["a", "b"], ["c"]]);
	});
});

describe("deduplicateCompositeIndexes", () => {
	it("removes duplicate column lists, preserving first-occurrence order", () => {
		expect(deduplicateCompositeIndexes([["a", "b"], ["c"], ["a", "b"]])).toEqual([["a", "b"], ["c"]]);
	});
	it("returns an empty array unchanged", () => {
		expect(deduplicateCompositeIndexes([])).toEqual([]);
	});
});
