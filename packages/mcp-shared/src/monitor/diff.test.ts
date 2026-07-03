import { describe, expect, it } from "vitest";
import { extractRowSets } from "./canonicalize";
import { diffSnapshots, diffTable } from "./diff";
import type { MonitorProfile, TableSpec } from "./types";

const SPEC: TableSpec = {
	table: "ex",
	path: "ex",
	keyFields: ["k"],
	ignoreFields: ["ts"],
};
const profile: MonitorProfile = { tables: [SPEC] };

const rs = (rows: Array<Record<string, unknown>>) => ({ table: "ex", rows });

describe("diffTable", () => {
	it("detects added, removed, changed and counts unchanged", () => {
		const prior = rs([
			{ k: "a", v: 1 },
			{ k: "b", v: 2 },
			{ k: "c", v: 3 },
		]);
		const next = rs([
			{ k: "a", v: 1 },
			{ k: "b", v: 9 },
			{ k: "d", v: 4 },
		]);
		const { changes, unchanged } = diffTable(prior, next, SPEC);
		expect(unchanged).toBe(1); // a
		const keysOf = (kind: string) =>
			changes.filter((c) => c.kind === kind).map((c) => c.key);
		expect(keysOf("added")).toEqual(["d"]);
		expect(keysOf("removed")).toEqual(["c"]);
		expect(keysOf("changed")).toEqual(["b"]);
		expect(changes.find((c) => c.kind === "changed")?.fields).toEqual([
			{ field: "v", before: 2, after: 9 },
		]);
	});

	it("reports no changes when rows only reorder", () => {
		const prior = rs([
			{ k: "a", v: 1 },
			{ k: "b", v: 2 },
		]);
		const next = rs([
			{ k: "b", v: 2 },
			{ k: "a", v: 1 },
		]);
		const { changes, unchanged } = diffTable(prior, next, SPEC);
		expect(changes).toEqual([]);
		expect(unchanged).toBe(2);
	});

	it("ignores volatile fields when deciding changed", () => {
		const prior = rs([{ k: "a", v: 1, ts: "T1" }]);
		const next = rs([{ k: "a", v: 1, ts: "T2" }]);
		expect(diffTable(prior, next, SPEC).changes).toEqual([]);
	});
});

describe("diffSnapshots", () => {
	it("summarizes per table and surfaces the changes", () => {
		const prior = extractRowSets({ ex: [{ k: "a", v: 1 }] }, profile);
		const next = extractRowSets(
			{
				ex: [
					{ k: "a", v: 1 },
					{ k: "b", v: 2 },
				],
			},
			profile,
		);
		const diff = diffSnapshots(prior, next, profile);
		expect(diff.summary).toEqual([
			{ table: "ex", added: 1, removed: 0, changed: 0, unchanged: 1 },
		]);
		expect(diff.changes.map((c) => c.kind)).toEqual(["added"]);
	});
});
