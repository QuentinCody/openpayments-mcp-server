import { describe, it, expect } from "vitest";
import { createChartResponse } from "./create-chart-response.js";
import type { ChartResponseOptions } from "./chart-types.js";

function makeOpts(
	overrides: Partial<ChartResponseOptions> = {},
): ChartResponseOptions {
	return {
		toolPrefix: "test",
		chart: {
			type: "bar",
			title: "Test Chart",
			xKey: "label",
			series: [{ name: "count", dataKey: "count" }],
			data: [
				{ label: "A", count: 10 },
				{ label: "B", count: 20 },
				{ label: "C", count: 5 },
			],
		},
		...overrides,
	};
}

describe("createChartResponse", () => {
	it("returns text content as first element", () => {
		const result = createChartResponse(makeOpts());
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain(
			"Test Chart",
		);
	});

	it("returns resource content as second element", () => {
		const result = createChartResponse(makeOpts());
		expect(result.content.length).toBe(2);
		expect(result.content[1].type).toBe("resource");
		const resource = result.content[1] as {
			resource: { uri: string; mimeType: string; blob: string };
		};
		expect(resource.resource.mimeType).toBe("text/html");
		expect(resource.resource.uri).toContain("test");
		expect(resource.resource.blob).toBeTruthy();
	});

	it("returns _chart in structuredContent", () => {
		const result = createChartResponse(makeOpts());
		expect(result.structuredContent.success).toBe(true);
		expect(result.structuredContent._chart.type).toBe("bar");
		expect(result.structuredContent._chart.data).toHaveLength(3);
	});

	it("handles empty data", () => {
		const result = createChartResponse(
			makeOpts({ chart: { ...makeOpts().chart, data: [] } }),
		);
		expect(result.content).toHaveLength(1);
		expect((result.content[0] as { text: string }).text).toContain(
			"No data available",
		);
		expect(result.structuredContent._chart.data).toHaveLength(0);
	});

	it("truncates data exceeding MAX_CHART_DATA_ROWS", () => {
		const bigData = Array.from({ length: 300 }, (_, i) => ({
			label: `Item ${i}`,
			count: i,
		}));
		const result = createChartResponse(
			makeOpts({ chart: { ...makeOpts().chart, data: bigData } }),
		);
		expect(result.structuredContent._chart.data.length).toBeLessThanOrEqual(
			200,
		);
		expect(
			(result.structuredContent.data as { truncated?: boolean }).truncated,
		).toBe(true);
		expect(
			(result.content[0] as { text: string }).text,
		).toContain("Showing 200 of 300");
	});

	it("prepends textPreamble when provided", () => {
		const result = createChartResponse(
			makeOpts({ textPreamble: "Here are the results:" }),
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text.startsWith("Here are the results:")).toBe(true);
	});

	it("decodes HTML resource blob to valid HTML", () => {
		const result = createChartResponse(makeOpts());
		const resource = result.content[1] as {
			resource: { blob: string };
		};
		const html = decodeURIComponent(escape(atob(resource.resource.blob)));
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("@observablehq/plot");
	});

	it("includes fetched_at in _meta", () => {
		const result = createChartResponse(makeOpts());
		expect(result.structuredContent._meta?.fetched_at).toBeTruthy();
	});
});
