/**
 * Terminal chart renderer — produces Unicode text strings from ChartSpec.
 *
 * Uses block characters (█) for bar charts and simple-ascii-chart for line/scatter.
 * Runs in Cloudflare Workers (no DOM, no Node.js APIs).
 */

import type { ChartSpec } from "./chart-types.js";

const MAX_ROWS = 30;
const BAR_WIDTH = 40;
const LABEL_WIDTH = 25;
const BLOCK = "\u2588";

export function renderUnicodeChart(spec: ChartSpec): string {
	if (!spec.data || spec.data.length === 0) {
		return `${spec.title}\n\n(No data to chart)`;
	}

	const dataKey = spec.series[0]?.dataKey;
	if (!dataKey) return `${spec.title}\n\n(No series defined)`;

	let rows = spec.data.slice(0, spec.maxCategories ?? MAX_ROWS);

	if (spec.sort === "desc") {
		rows = [...rows].sort(
			(a, b) => toNum(b[dataKey]) - toNum(a[dataKey]),
		);
	} else if (spec.sort === "asc") {
		rows = [...rows].sort(
			(a, b) => toNum(a[dataKey]) - toNum(b[dataKey]),
		);
	}

	switch (spec.type) {
		case "bar":
		case "grouped-bar":
		case "stacked-bar":
			return renderVerticalBar(spec, rows, dataKey);
		case "horizontal-bar":
			return renderHorizontalBar(spec, rows, dataKey);
		case "pie":
			return renderPieAsText(spec, rows, dataKey);
		case "line":
			return renderLine(spec, rows, dataKey);
		case "scatter":
			return renderScatter(spec, rows, dataKey);
		case "histogram":
			return renderVerticalBar(spec, rows, dataKey);
		case "heatmap":
			return renderHeatmapAsText(spec, rows, dataKey);
		default:
			return renderHorizontalBar(spec, rows, dataKey);
	}
}

function renderHorizontalBar(
	spec: ChartSpec,
	rows: Record<string, unknown>[],
	dataKey: string,
): string {
	const maxVal = Math.max(...rows.map((r) => toNum(r[dataKey])), 1);
	const lines: string[] = [spec.title, ""];

	for (const row of rows) {
		const label = truncStr(String(row[spec.xKey] ?? ""), LABEL_WIDTH).padEnd(
			LABEL_WIDTH,
		);
		const val = toNum(row[dataKey]);
		const barLen =
			maxVal > 0 ? Math.max(Math.round((val / maxVal) * BAR_WIDTH), 0) : 0;
		const bar = BLOCK.repeat(barLen);
		lines.push(`  ${label} ${bar} ${fmtVal(val, spec.numberFormat)}`);
	}

	if (spec.source) lines.push("", `Source: ${spec.source}`);
	return lines.join("\n");
}

function renderVerticalBar(
	spec: ChartSpec,
	rows: Record<string, unknown>[],
	dataKey: string,
): string {
	// For terminal, vertical bars are hard to render well. Use horizontal layout
	// with the title indicating it's a bar chart.
	return renderHorizontalBar(spec, rows, dataKey);
}

function renderPieAsText(
	spec: ChartSpec,
	rows: Record<string, unknown>[],
	dataKey: string,
): string {
	const total = rows.reduce((s, r) => s + toNum(r[dataKey]), 0);
	const lines: string[] = [spec.title, ""];

	for (const row of rows) {
		const val = toNum(row[dataKey]);
		const pct = total > 0 ? ((val / total) * 100).toFixed(1) : "0.0";
		const label = truncStr(String(row[spec.xKey] ?? ""), LABEL_WIDTH).padEnd(
			LABEL_WIDTH,
		);
		lines.push(
			`  ${label} ${pct.padStart(5)}%  (${fmtVal(val, spec.numberFormat)})`,
		);
	}

	if (spec.source) lines.push("", `Source: ${spec.source}`);
	return lines.join("\n");
}

function renderLine(
	spec: ChartSpec,
	rows: Record<string, unknown>[],
	dataKey: string,
): string {
	// Simple sparkline-style line using Unicode block elements
	const HEIGHT = 8;
	const vals = rows.map((r) => toNum(r[dataKey]));
	const min = Math.min(...vals);
	const max = Math.max(...vals);
	const range = max - min || 1;

	const lines: string[] = [spec.title, ""];

	// Build character grid
	const grid: string[][] = Array.from({ length: HEIGHT }, () =>
		Array(vals.length).fill(" "),
	);

	for (let i = 0; i < vals.length; i++) {
		const normalized = (vals[i] - min) / range;
		const row = HEIGHT - 1 - Math.round(normalized * (HEIGHT - 1));
		grid[row][i] = "\u2022"; // bullet
	}

	const maxLabel = fmtVal(max, spec.numberFormat);
	const minLabel = fmtVal(min, spec.numberFormat);
	const pad = Math.max(maxLabel.length, minLabel.length) + 1;

	for (let r = 0; r < HEIGHT; r++) {
		const label =
			r === 0
				? maxLabel.padStart(pad)
				: r === HEIGHT - 1
					? minLabel.padStart(pad)
					: " ".repeat(pad);
		lines.push(`${label} \u2502${grid[r].join("")}`);
	}
	lines.push(`${" ".repeat(pad)} \u2514${"─".repeat(vals.length)}`);

	if (spec.source) lines.push("", `Source: ${spec.source}`);
	return lines.join("\n");
}

function renderScatter(
	spec: ChartSpec,
	rows: Record<string, unknown>[],
	dataKey: string,
): string {
	// Scatter as a table since terminal scatter is hard to read
	const lines: string[] = [spec.title, ""];
	const xLabel = (spec.xLabel || spec.xKey).padEnd(LABEL_WIDTH);
	const yLabel = spec.yLabel || dataKey;
	lines.push(`  ${xLabel} ${yLabel}`);
	lines.push(`  ${"─".repeat(LABEL_WIDTH + yLabel.length + 2)}`);

	for (const row of rows) {
		const label = truncStr(String(row[spec.xKey] ?? ""), LABEL_WIDTH).padEnd(
			LABEL_WIDTH,
		);
		const val = fmtVal(toNum(row[dataKey]), spec.numberFormat);
		lines.push(`  ${label} ${val}`);
	}

	if (spec.source) lines.push("", `Source: ${spec.source}`);
	return lines.join("\n");
}

function renderHeatmapAsText(
	spec: ChartSpec,
	rows: Record<string, unknown>[],
	dataKey: string,
): string {
	// Heatmap as a value table
	return renderScatter(spec, rows, dataKey);
}

function toNum(v: unknown): number {
	if (typeof v === "number") return v;
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

function truncStr(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
}

function fmtVal(val: number, fmt?: string): string {
	switch (fmt) {
		case "percent":
			return `${(val * 100).toFixed(1)}%`;
		case "currency":
			return `$${val.toFixed(2)}`;
		case "scientific":
			return val.toExponential(2);
		case "integer":
			return Math.round(val).toLocaleString("en-US");
		default:
			return Number.isInteger(val)
				? val.toLocaleString("en-US")
				: val.toFixed(2);
	}
}
