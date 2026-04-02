import { describe, it, expect } from "vitest";
import { renderUnicodeChart } from "./unicode-chart.js";
import type { ChartSpec } from "./chart-types.js";

function makeSpec(overrides: Partial<ChartSpec> = {}): ChartSpec {
	return {
		type: "bar",
		title: "Test Chart",
		xKey: "label",
		series: [{ name: "count", dataKey: "count" }],
		data: [
			{ label: "A", count: 10 },
			{ label: "B", count: 20 },
			{ label: "C", count: 5 },
		],
		...overrides,
	};
}

describe("renderUnicodeChart", () => {
	it("renders a bar chart with title and bars", () => {
		const result = renderUnicodeChart(makeSpec());
		expect(result).toContain("Test Chart");
		expect(result).toContain("A");
		expect(result).toContain("B");
		expect(result).toContain("C");
		expect(result).toContain("\u2588"); // block character
	});

	it("handles empty data", () => {
		const result = renderUnicodeChart(makeSpec({ data: [] }));
		expect(result).toContain("No data to chart");
	});

	it("handles no series defined", () => {
		const result = renderUnicodeChart(makeSpec({ series: [] }));
		expect(result).toContain("No series defined");
	});

	it("sorts descending when requested", () => {
		const result = renderUnicodeChart(makeSpec({ sort: "desc" }));
		const lines = result.split("\n").filter((l) => l.includes("\u2588"));
		// B (20) should come before A (10) which comes before C (5)
		const bIdx = lines.findIndex((l) => l.includes("B"));
		const aIdx = lines.findIndex((l) => l.includes("A"));
		const cIdx = lines.findIndex((l) => l.includes("C"));
		expect(bIdx).toBeLessThan(aIdx);
		expect(aIdx).toBeLessThan(cIdx);
	});

	it("sorts ascending when requested", () => {
		const result = renderUnicodeChart(makeSpec({ sort: "asc" }));
		const lines = result.split("\n").filter((l) => l.includes("\u2588"));
		const cIdx = lines.findIndex((l) => l.includes("C"));
		const bIdx = lines.findIndex((l) => l.includes("B"));
		expect(cIdx).toBeLessThan(bIdx);
	});

	it("truncates to maxCategories", () => {
		const data = Array.from({ length: 50 }, (_, i) => ({
			label: `Item ${i}`,
			count: i + 1,
		}));
		const result = renderUnicodeChart(makeSpec({ data, maxCategories: 5 }));
		const barLines = result.split("\n").filter((l) => l.includes("\u2588"));
		expect(barLines.length).toBe(5);
	});

	it("renders horizontal-bar type", () => {
		const result = renderUnicodeChart(makeSpec({ type: "horizontal-bar" }));
		expect(result).toContain("Test Chart");
		expect(result).toContain("\u2588");
	});

	it("renders pie as percentage breakdown", () => {
		const result = renderUnicodeChart(makeSpec({ type: "pie" }));
		expect(result).toContain("%");
		expect(result).toContain("A");
	});

	it("renders line chart with bullets", () => {
		const result = renderUnicodeChart(makeSpec({ type: "line" }));
		expect(result).toContain("Test Chart");
		expect(result).toContain("\u2022"); // bullet
	});

	it("renders scatter as table", () => {
		const result = renderUnicodeChart(makeSpec({ type: "scatter" }));
		expect(result).toContain("Test Chart");
		expect(result).toContain("A");
		expect(result).toContain("10");
	});

	it("formats values with numberFormat", () => {
		const result = renderUnicodeChart(
			makeSpec({
				numberFormat: "currency",
				data: [{ label: "Drug", count: 42.5 }],
			}),
		);
		expect(result).toContain("$42.50");
	});

	it("includes source attribution", () => {
		const result = renderUnicodeChart(makeSpec({ source: "FDA FAERS" }));
		expect(result).toContain("Source: FDA FAERS");
	});

	it("truncates long labels", () => {
		const result = renderUnicodeChart(
			makeSpec({
				data: [
					{
						label: "This is a very long label that should be truncated",
						count: 10,
					},
				],
			}),
		);
		expect(result).toContain("\u2026"); // ellipsis
	});

	it("handles non-numeric values gracefully", () => {
		const result = renderUnicodeChart(
			makeSpec({ data: [{ label: "X", count: "not a number" }] }),
		);
		// Should not throw, treats as 0
		expect(result).toContain("X");
	});

	it("handles single data point", () => {
		const result = renderUnicodeChart(
			makeSpec({ data: [{ label: "Only", count: 42 }] }),
		);
		expect(result).toContain("Only");
		expect(result).toContain("42");
	});
});
