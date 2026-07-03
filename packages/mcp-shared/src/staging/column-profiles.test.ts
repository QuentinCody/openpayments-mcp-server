import { describe, expect, it } from "vitest";
import { computeColumnProfiles } from "./column-profiles";
import type { InferredSchema } from "./schema-inference";

// computeColumnProfiles drives everything through sql.exec(query) — emulate the
// few query shapes profileColumn issues with ordered regex rules. A rule value
// may be a thunk so a test can make one query throw (the non-critical catches).
type Row = Record<string, unknown>;
type Rule = [RegExp, Row[] | (() => Row[])];

const fakeSql = (rules: Rule[]) => ({
	exec: (query: string) => {
		for (const [pattern, result] of rules) {
			if (pattern.test(query)) {
				const rows = typeof result === "function" ? result() : result;
				return { toArray: () => rows, one: () => rows[0] };
			}
		}
		throw new Error(`fakeSql: unmatched query: ${query}`);
	},
});

const schemaOf = (
	columns: Array<{ name: string; type: string }>,
): InferredSchema =>
	({ tables: [{ name: "t", columns }] }) as unknown as InferredSchema;

// Ordered most-specific-first; the bare COUNT(*) rule must come last.
const baseRules = (
	over: Partial<
		Record<
			"nulls" | "distinct" | "peek" | "minmax" | "samples" | "top" | "rows",
			Rule[1]
		>
	> = {},
): Rule[] => [
	[/IS NULL/, over.nulls ?? [{ c: 1 }]],
	[
		/SELECT COUNT\(\*\) as c FROM \(SELECT DISTINCT/,
		over.distinct ?? [{ c: 3 }],
	],
	[
		/GROUP BY/,
		over.top ?? [
			{ v: "a", c: 5 },
			{ v: "b", c: 2 },
		],
	],
	[/MIN\(/, over.minmax ?? [{ min_val: "a", max_val: "z" }]],
	[/LIMIT 1$/, over.peek ?? [{ v: "a" }]],
	[/SELECT DISTINCT .* as v/, over.samples ?? [{ v: "a" }, { v: "b" }]],
	[/SELECT COUNT\(\*\) as c FROM "t"$/, over.rows ?? [{ c: 10 }]],
];

describe("computeColumnProfiles / profileColumn", () => {
	it("profiles a low-cardinality TEXT column fully (min/max, samples, top values)", () => {
		const [profile] = computeColumnProfiles(
			schemaOf([{ name: "status", type: "TEXT" }]),
			fakeSql(baseRules()),
		);
		expect(profile.table).toBe("t");
		expect(profile.row_count).toBe(10);
		expect(profile.columns.status).toEqual({
			null_count: 1,
			distinct_count: 3,
			min: "a",
			max: "z",
			sample_values: ["a", "b"],
			top_values: [
				{ value: "a", count: 5 },
				{ value: "b", count: 2 },
			],
		});
	});

	it("returns an empty profile for an empty table", () => {
		const [profile] = computeColumnProfiles(
			schemaOf([{ name: "x", type: "TEXT" }]),
			fakeSql([[/SELECT COUNT\(\*\) as c FROM "t"$/, [{ c: 0 }]]]),
		);
		expect(profile).toEqual({ table: "t", row_count: 0, columns: {} });
	});

	it("skips the synthetic parent_id column", () => {
		const [profile] = computeColumnProfiles(
			schemaOf([
				{ name: "parent_id", type: "INTEGER" },
				{ name: "status", type: "TEXT" },
			]),
			fakeSql(baseRules()),
		);
		expect(Object.keys(profile.columns)).toEqual(["status"]);
	});

	it("caps distinct counts and skips top_values for high-cardinality columns", () => {
		const [profile] = computeColumnProfiles(
			schemaOf([{ name: "id_col", type: "TEXT" }]),
			fakeSql(baseRules({ distinct: [{ c: 101 }] })),
		);
		expect(profile.columns.id_col.distinct_capped).toBe(true);
		expect(profile.columns.id_col.top_values).toBeUndefined();
		// not low-value (peek isn't a URL), so min/max/samples still present
		expect(profile.columns.id_col.min).toBe("a");
	});

	it("reports only null/distinct counts for URL-identifier columns", () => {
		const [profile] = computeColumnProfiles(
			schemaOf([{ name: "self_url", type: "TEXT" }]),
			fakeSql(
				baseRules({
					distinct: [{ c: 10 }],
					peek: [{ v: "https://api.example.org/x/1" }],
				}),
			),
		);
		// distinct (10) >= 90% of rowCount (10) and the peeked value is a URL
		expect(profile.columns.self_url).toEqual({
			null_count: 1,
			distinct_count: 10,
		});
	});

	it("treats _links_* columns as low-value regardless of cardinality", () => {
		const [profile] = computeColumnProfiles(
			schemaOf([{ name: "_links_self", type: "TEXT" }]),
			fakeSql(baseRules()),
		);
		expect(profile.columns._links_self).toEqual({
			null_count: 1,
			distinct_count: 3,
		});
	});

	it("skips min/max and samples for JSON columns but keeps top_values", () => {
		const [profile] = computeColumnProfiles(
			schemaOf([{ name: "payload", type: "JSON" }]),
			fakeSql(baseRules()),
		);
		const col = profile.columns.payload;
		expect(col.min).toBeUndefined();
		expect(col.sample_values).toBeUndefined();
		expect(col.top_values).toHaveLength(2);
	});

	it("truncates long sample strings to 120 chars", () => {
		const long = "x".repeat(150);
		const [profile] = computeColumnProfiles(
			schemaOf([{ name: "blob", type: "TEXT" }]),
			fakeSql(baseRules({ samples: [{ v: long }, { v: 42 }] })),
		);
		expect(profile.columns.blob.sample_values).toEqual([
			`${"x".repeat(117)}...`,
			42,
		]);
	});

	it("survives non-critical query failures (peek and min/max throwing)", () => {
		const boom = () => {
			throw new Error("no such column");
		};
		const [profile] = computeColumnProfiles(
			schemaOf([{ name: "flaky", type: "TEXT" }]),
			fakeSql(baseRules({ peek: boom, minmax: boom })),
		);
		expect(profile.columns.flaky.null_count).toBe(1);
		expect(profile.columns.flaky.min).toBeUndefined();
		expect(profile.columns.flaky.sample_values).toEqual(["a", "b"]);
	});
});
