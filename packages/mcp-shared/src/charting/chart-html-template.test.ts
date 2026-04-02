import { describe, it, expect } from "vitest";
import { buildChartHtml } from "./chart-html-template.js";
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
		],
		...overrides,
	};
}

describe("buildChartHtml", () => {
	it("produces valid HTML with doctype", () => {
		const html = buildChartHtml(makeSpec());
		expect(html).toMatch(/^<!DOCTYPE html>/);
		expect(html).toContain("</html>");
	});

	it("includes the chart title", () => {
		const html = buildChartHtml(makeSpec({ title: "My Chart Title" }));
		expect(html).toContain("My Chart Title");
	});

	it("includes subtitle when provided", () => {
		const html = buildChartHtml(makeSpec({ subtitle: "2024 data" }));
		expect(html).toContain("2024 data");
	});

	it("omits subtitle div when not provided", () => {
		const html = buildChartHtml(makeSpec({ subtitle: undefined }));
		expect(html).not.toContain('class="sub"');
	});

	it("includes source attribution when provided", () => {
		const html = buildChartHtml(makeSpec({ source: "FDA FAERS" }));
		expect(html).toContain("Source: FDA FAERS");
	});

	it("imports Observable Plot from CDN", () => {
		const html = buildChartHtml(makeSpec());
		expect(html).toContain("cdn.jsdelivr.net/npm/@observablehq/plot");
	});

	it("embeds data as JSON", () => {
		const html = buildChartHtml(makeSpec());
		expect(html).toContain('"label"');
		expect(html).toContain('"count"');
	});

	it("escapes HTML in title", () => {
		const html = buildChartHtml(makeSpec({ title: '<script>alert("xss")</script>' }));
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("&lt;script&gt;");
	});

	it("escapes angle brackets in data JSON", () => {
		const html = buildChartHtml(
			makeSpec({ data: [{ label: "<b>bold</b>", count: 1 }] }),
		);
		expect(html).not.toContain("<b>bold</b>");
		expect(html).toContain("\\u003c");
	});

	it("includes export buttons", () => {
		const html = buildChartHtml(makeSpec());
		expect(html).toContain("Export SVG");
		expect(html).toContain("Export CSV");
	});

	it("sends MCP Apps ready signal", () => {
		const html = buildChartHtml(makeSpec());
		expect(html).toContain("ui-lifecycle-iframe-ready");
	});

	it("handles each chart type without error", () => {
		const types = [
			"bar", "horizontal-bar", "line", "scatter", "pie",
			"heatmap", "grouped-bar", "stacked-bar", "histogram",
		] as const;
		for (const type of types) {
			const html = buildChartHtml(makeSpec({ type }));
			expect(html).toContain("<!DOCTYPE html>");
		}
	});

	it("includes dark mode styles", () => {
		const html = buildChartHtml(makeSpec());
		expect(html).toContain("prefers-color-scheme:dark");
	});
});
