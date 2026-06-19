import { describe, expect, it } from "vitest";
import { hasNestedEntities } from "./staging-engine";

// isEntity (standard mode): has id/_id, or >=2 fields with a name/title/
// description/type marker. Fixtures below carry an id to be unambiguous.
const entity = (over: Record<string, unknown> = {}) => ({ id: 7, name: "x", ...over });

describe("hasNestedEntities", () => {
	it("rejects non-objects, arrays, and non-entities", () => {
		expect(hasNestedEntities(null)).toBe(false);
		expect(hasNestedEntities("str")).toBe(false);
		expect(hasNestedEntities([entity()])).toBe(false);
		expect(hasNestedEntities({ name: "no id, single field" })).toBe(false);
	});

	it("detects a direct array of child entities (and only entities)", () => {
		expect(hasNestedEntities(entity({ tags: [entity({ id: 1 })] }))).toBe(true);
		expect(hasNestedEntities(entity({ tags: ["scalar"] }))).toBe(false);
		expect(hasNestedEntities(entity({ tags: [] }))).toBe(false);
	});

	it("detects entities behind nodes / edges / rows wrappers", () => {
		expect(hasNestedEntities(entity({ kids: { nodes: [entity()] } }))).toBe(true);
		expect(hasNestedEntities(entity({ kids: { edges: [{ node: entity() }] } }))).toBe(true);
		expect(hasNestedEntities(entity({ kids: { rows: [entity()] } }))).toBe(true);
		expect(hasNestedEntities(entity({ kids: { nodes: [], edges: [], rows: [] } }))).toBe(false);
	});

	it("still finds rows when the first edge has no node (wrapper checks are independent)", () => {
		expect(hasNestedEntities(entity({ kids: { edges: [{}], rows: [entity()] } }))).toBe(true);
	});

	it("recurses into 1:1 nested entities", () => {
		const inner = entity({ children: [entity({ id: 2 })] });
		expect(hasNestedEntities(entity({ profile: inner }))).toBe(true);
		expect(hasNestedEntities(entity({ profile: entity() }))).toBe(false);
	});

	it("ignores scalar and plain-object properties", () => {
		expect(hasNestedEntities(entity({ count: 3, meta: { note: "hi" } }))).toBe(false);
	});
});
