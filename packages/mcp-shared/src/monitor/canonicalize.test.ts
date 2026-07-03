import { describe, expect, it } from "vitest";
import {
	canonicalValue,
	cleanResult,
	extractRowSets,
	reparse,
	resolvePath,
	rowKey,
	selectValueFields,
	snapshotHash,
} from "./canonicalize";
import type { MonitorProfile, TableSpec } from "./types";

const SPEC: TableSpec = {
	table: "patents",
	path: "patents",
	keyFields: ["Appl_No", "Patent_No"],
	ignoreFields: ["retrieved_at"],
};

describe("resolvePath", () => {
	it("resolves nested dot-paths and returns undefined for missing", () => {
		expect(resolvePath({ a: { b: [1, 2] } }, "a.b")).toEqual([1, 2]);
		expect(resolvePath({ a: 1 }, "a.b.c")).toBeUndefined();
		expect(resolvePath({ a: 1 }, "")).toEqual({ a: 1 });
	});
});

describe("cleanResult", () => {
	it("strips declared envelope keys", () => {
		const profile: MonitorProfile = {
			stripKeys: ["total", "offset"],
			tables: [],
		};
		expect(cleanResult({ total: 9, offset: 0, results: [1] }, profile)).toEqual(
			{ results: [1] },
		);
	});
	it("passes arrays and scalars through untouched", () => {
		const profile: MonitorProfile = { tables: [] };
		expect(cleanResult([1, 2], profile)).toEqual([1, 2]);
	});
});

describe("extractRowSets", () => {
	it("locates the row array by path and drops non-objects", () => {
		const profile: MonitorProfile = { tables: [SPEC] };
		const rs = extractRowSets(
			{ patents: [{ Appl_No: "1" }, 5, null] },
			profile,
		);
		expect(rs).toHaveLength(1);
		expect(rs[0].rows).toEqual([{ Appl_No: "1" }]);
	});
	it("yields an empty row-set when the path is absent", () => {
		const profile: MonitorProfile = { tables: [SPEC] };
		expect(extractRowSets({}, profile)[0].rows).toEqual([]);
	});
});

describe("rowKey", () => {
	it("joins composite key fields with the separator", () => {
		expect(rowKey({ Appl_No: "202155", Patent_No: "6967208" }, SPEC)).toBe(
			"202155|6967208",
		);
	});
	it("renders missing key parts as empty", () => {
		expect(rowKey({ Appl_No: "202155" }, SPEC)).toBe("202155|");
	});
});

describe("selectValueFields", () => {
	it("defaults to all non-key, non-ignored fields", () => {
		const fields = selectValueFields(
			{ Appl_No: "1", Patent_No: "2", Expire: "x", retrieved_at: "t" },
			SPEC,
		);
		expect(fields).toEqual(["Expire"]);
	});
	it("honors an explicit valueFields list", () => {
		const spec: TableSpec = { ...SPEC, valueFields: ["Expire"] };
		expect(selectValueFields({ Expire: "x", Other: "y" }, spec)).toEqual([
			"Expire",
		]);
	});
});

describe("reparse", () => {
	it("re-parses stringified JSON to a stable form", () => {
		expect(reparse('{"b":1,"a":2}')).toEqual({ b: 1, a: 2 });
	});
	it("splits and sorts pipe-delimited scalar arrays", () => {
		expect(reparse("C | A | B")).toEqual(["A", "B", "C"]);
	});
	it("leaves plain strings and non-strings untouched", () => {
		expect(reparse("Apr 17, 2028")).toBe("Apr 17, 2028");
		expect(reparse(5)).toBe(5);
	});
});

describe("canonicalValue", () => {
	it("is independent of upstream key order", () => {
		const a = canonicalValue(
			{ Appl_No: "1", Patent_No: "2", x: 1, y: 2 },
			SPEC,
		);
		const b = canonicalValue(
			{ y: 2, x: 1, Patent_No: "2", Appl_No: "1" },
			SPEC,
		);
		expect(a).toBe(b);
	});
});

describe("snapshotHash", () => {
	const profile: MonitorProfile = { tables: [SPEC] };
	it("is identical when rows are reordered (the Tier-1 synthetic-PK trap)", async () => {
		const r1 = extractRowSets(
			{
				patents: [
					{ Appl_No: "1", Patent_No: "A", v: 1 },
					{ Appl_No: "1", Patent_No: "B", v: 2 },
				],
			},
			profile,
		);
		const r2 = extractRowSets(
			{
				patents: [
					{ Appl_No: "1", Patent_No: "B", v: 2 },
					{ Appl_No: "1", Patent_No: "A", v: 1 },
				],
			},
			profile,
		);
		expect(await snapshotHash(r1, profile)).toBe(
			await snapshotHash(r2, profile),
		);
	});
	it("changes when a value field changes", async () => {
		const r1 = extractRowSets(
			{ patents: [{ Appl_No: "1", Patent_No: "A", v: 1 }] },
			profile,
		);
		const r2 = extractRowSets(
			{ patents: [{ Appl_No: "1", Patent_No: "A", v: 9 }] },
			profile,
		);
		expect(await snapshotHash(r1, profile)).not.toBe(
			await snapshotHash(r2, profile),
		);
	});
});
