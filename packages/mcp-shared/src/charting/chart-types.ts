/**
 * Universal chart specification — carried in structuredContent._chart.
 *
 * Consumed by:
 * - unicode-chart.ts → ASCII text (server-side, in Worker)
 * - chart-html-template.ts → Observable Plot HTML (server-side, for MCP Apps)
 * - Frontend ChartDisplay component → Recharts (client-side, in browser)
 */

export type ChartType =
	| "bar"
	| "horizontal-bar"
	| "line"
	| "scatter"
	| "pie"
	| "heatmap"
	| "grouped-bar"
	| "stacked-bar"
	| "histogram";

export interface ChartSeries {
	/** Human-readable series label */
	name: string;
	/** Key in each data row for this series' values */
	dataKey: string;
	/** Optional hex color override */
	color?: string;
}

export interface ChartSpec {
	type: ChartType;
	title: string;
	subtitle?: string;
	/** Column key for X-axis / categories */
	xKey: string;
	xLabel?: string;
	yLabel?: string;
	/** At least one series required */
	series: ChartSeries[];
	/** Data rows — flat objects */
	data: Record<string, unknown>[];
	/** Sort categories by first series value */
	sort?: "asc" | "desc" | "none";
	/** Max categories to display (remainder truncated) */
	maxCategories?: number;
	/** Number formatting hint */
	numberFormat?: "integer" | "percent" | "currency" | "scientific";
	/** Source attribution (e.g., "OpenFDA FAERS") */
	source?: string;
}

export interface ChartResponseOptions {
	chart: ChartSpec;
	/** Tool prefix for resource URI namespacing (e.g., "faers") */
	toolPrefix: string;
	/** Text to prepend before the Unicode chart */
	textPreamble?: string;
}
