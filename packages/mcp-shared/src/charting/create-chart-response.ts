/**
 * Main chart response factory — produces a multi-format response
 * compatible with all three client tiers:
 *
 *   content[0] = Unicode text chart (CLI)
 *   content[1] = EmbeddedResource HTML (MCP Apps GUI clients)
 *   structuredContent._chart = ChartSpec (our Next.js web app)
 *
 * Runs in the Cloudflare Worker (MCP Server), not the V8 isolate sandbox.
 */

import type { ChartSpec, ChartResponseOptions } from "./chart-types.js";
import { renderUnicodeChart } from "./unicode-chart.js";
import { buildChartHtml } from "./chart-html-template.js";

const MAX_CHART_DATA_ROWS = 200;

export interface ChartTextContent {
	type: "text";
	text: string;
}

export interface ChartResourceContent {
	type: "resource";
	resource: { uri: string; mimeType: string; blob: string };
}

export interface ChartResponseResult {
	content: Array<ChartTextContent | ChartResourceContent>;
	structuredContent: {
		success: true;
		data: Record<string, unknown>;
		_chart: ChartSpec;
		_meta?: Record<string, unknown>;
	};
}

export function createChartResponse(options: ChartResponseOptions): ChartResponseResult {
	const { chart, toolPrefix, textPreamble } = options;

	if (!chart.data || chart.data.length === 0) {
		return emptyChartResponse(chart);
	}

	const truncated = chart.data.length > MAX_CHART_DATA_ROWS;
	const chartData = truncated
		? chart.data.slice(0, MAX_CHART_DATA_ROWS)
		: chart.data;
	const spec: ChartSpec = { ...chart, data: chartData };

	const unicodeChart = renderUnicodeChart(spec);
	const textContent = textPreamble
		? `${textPreamble}\n\n${unicodeChart}`
		: unicodeChart;
	const truncationNote = truncated
		? `\n\n(Showing ${MAX_CHART_DATA_ROWS} of ${chart.data.length} data points)`
		: "";

	const htmlContent = buildChartHtml(spec);
	const htmlBase64 = btoa(unescape(encodeURIComponent(htmlContent)));

	return {
		content: [
			{ type: "text" as const, text: textContent + truncationNote },
			{
				type: "resource" as const,
				resource: {
					uri: `chart://${toolPrefix}/${encodeURIComponent(chart.title)}`,
					mimeType: "text/html",
					blob: htmlBase64,
				},
			},
		],
		structuredContent: {
			success: true,
			data: {
				chart_rendered: true,
				title: spec.title,
				type: spec.type,
				data_points: chartData.length,
				...(truncated
					? { truncated: true, total_data_points: chart.data.length }
					: {}),
			},
			_chart: spec,
			_meta: { fetched_at: new Date().toISOString() },
		},
	};
}

function emptyChartResponse(chart: ChartSpec): ChartResponseResult {
	return {
		content: [
			{
				type: "text" as const,
				text: `${chart.title}\n\nNo data available to chart.`,
			},
		],
		structuredContent: {
			success: true as const,
			data: { message: "No data available to chart" },
			_chart: { ...chart, data: [] as Record<string, unknown>[] },
		},
	};
}
