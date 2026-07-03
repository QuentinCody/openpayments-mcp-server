import { describe, expect, it } from "vitest";
import { hasNestedEntities, stageData } from "./staging-engine";
import type { SqlExec } from "./types";

// isEntity (standard mode): has id/_id, or >=2 fields with a name/title/
// description/type marker. Fixtures below carry an id to be unambiguous.
const entity = (over: Record<string, unknown> = {}) => ({
	id: 7,
	name: "x",
	...over,
});

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
		expect(hasNestedEntities(entity({ kids: { nodes: [entity()] } }))).toBe(
			true,
		);
		expect(
			hasNestedEntities(entity({ kids: { edges: [{ node: entity() }] } })),
		).toBe(true);
		expect(hasNestedEntities(entity({ kids: { rows: [entity()] } }))).toBe(
			true,
		);
		expect(
			hasNestedEntities(entity({ kids: { nodes: [], edges: [], rows: [] } })),
		).toBe(false);
	});

	it("still finds rows when the first edge has no node (wrapper checks are independent)", () => {
		expect(
			hasNestedEntities(entity({ kids: { edges: [{}], rows: [entity()] } })),
		).toBe(true);
	});

	it("recurses into 1:1 nested entities", () => {
		const inner = entity({ children: [entity({ id: 2 })] });
		expect(hasNestedEntities(entity({ profile: inner }))).toBe(true);
		expect(hasNestedEntities(entity({ profile: entity() }))).toBe(false);
	});

	it("ignores scalar and plain-object properties", () => {
		expect(hasNestedEntities(entity({ count: 3, meta: { note: "hi" } }))).toBe(
			false,
		);
	});
});

// A SqlExec stub that throws on the Nth CREATE TABLE (to simulate a SQLite
// limit such as "too many columns"), records every payloads INSERT, and answers
// COUNT(*) from those records. Exercises the T5.3 never-fail-to-zero path.
const failingCreateSql = (failOnCreateNumber: number) => {
	let creates = 0;
	const payloadInserts: unknown[][] = [];
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			if (/create\s+table/i.test(query)) {
				creates++;
				if (creates === failOnCreateNumber) {
					throw new Error("too many columns on table foo (SQLITE_ERROR)");
				}
			}
			if (/insert\s+into\s+payloads/i.test(query)) payloadInserts.push(bindings);
			if (/count/i.test(query)) {
				const row = { c: payloadInserts.length };
				return { toArray: () => [row], one: () => row };
			}
			return { toArray: () => [], one: () => undefined };
		},
	};
	return { sql: sql as unknown as SqlExec, payloadInserts };
};

describe("stageData — T5.3 never hard-fail to zero", () => {
	it("falls back to a raw JSON payload when structured materialization throws", () => {
		// The first CREATE TABLE (the data table) throws; storeFallbackPayload's
		// own CREATE/INSERT (creates #2) must still succeed.
		const { sql, payloadInserts } = failingCreateSql(1);
		const data = { items: [{ a: 1 }, { a: 2 }] };

		const result = stageData(data, sql);

		expect(result.success).toBe(true);
		expect(result.tablesCreated).toEqual(["payloads"]);
		expect(result.totalRows).toBe(1);
		// The whole response is preserved as the queryable blob.
		expect(payloadInserts).toHaveLength(1);
		expect(payloadInserts[0]?.[0]).toBe(JSON.stringify(data));
		// The failure reason is surfaced, not swallowed.
		expect(result.error).toMatch(/structured staging failed/i);
		expect(result.error).toMatch(/too many columns/i);
	});

	it("does not stamp an error on the ordinary no-array payload fallback", () => {
		const { sql, payloadInserts } = failingCreateSql(999); // never throws
		const result = stageData({ scalar: "no arrays here" }, sql);

		expect(result.success).toBe(true);
		expect(result.tablesCreated).toEqual(["payloads"]);
		expect(result.error).toBeUndefined();
		expect(payloadInserts).toHaveLength(1);
	});
});
