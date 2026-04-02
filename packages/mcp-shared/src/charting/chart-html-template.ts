/**
 * MCP Apps HTML builder — produces a self-contained HTML document
 * with Observable Plot loaded from CDN for interactive charting.
 *
 * Returned as an EmbeddedResource with mimeType "text/html" for
 * GUI MCP clients (Claude Desktop, VS Code Insiders, ChatGPT, Goose).
 */

import type { ChartSpec } from "./chart-types.js";

const CHART_STYLES = `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;padding:16px;background:#fff;color:#1a1a2e}
@media(prefers-color-scheme:dark){body{background:#1a1a2e;color:#e0e0e0}}
h2{font-size:15px;font-weight:600;margin-bottom:2px}
.sub{color:#666;font-size:11px;margin-bottom:12px}
.src{color:#999;font-size:10px;margin-top:8px}
#chart{width:100%;overflow-x:auto}
#chart svg{font-family:system-ui,-apple-system,sans-serif}
.actions{margin-top:8px;display:flex;gap:8px}
.actions button{font-size:11px;padding:4px 10px;border:1px solid #ccc;border-radius:4px;
  background:#f8f8f8;cursor:pointer}
.actions button:hover{background:#eee}
@media(prefers-color-scheme:dark){
  .actions button{background:#2a2a4e;border-color:#444;color:#e0e0e0}
  .actions button:hover{background:#3a3a5e}
  .sub{color:#999}
}
</style>`;

export function buildChartHtml(spec: ChartSpec): string {
	const safeData = escJson(JSON.stringify(spec.data));
	const safeSpec = escJson(
		JSON.stringify({
			type: spec.type,
			xKey: spec.xKey,
			xLabel: spec.xLabel,
			yLabel: spec.yLabel,
			series: spec.series,
			sort: spec.sort,
			maxCategories: spec.maxCategories,
			numberFormat: spec.numberFormat,
		}),
	);

	const safeTitle = esc(spec.title);
	const fileSlug = spec.title.replace(/[^a-zA-Z0-9]/g, "_");
	const subtitleHtml = spec.subtitle
		? `<div class="sub">${esc(spec.subtitle)}</div>`
		: "";
	const sourceHtml = spec.source
		? `<div class="src">Source: ${esc(spec.source)}</div>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
${CHART_STYLES}
</head>
<body>
<h2>${safeTitle}</h2>
${subtitleHtml}
<div id="chart"></div>
${sourceHtml}
<div class="actions">
  <button onclick="exportSvg()">Export SVG</button>
  <button onclick="exportCsv()">Export CSV</button>
</div>
<script type="module">
import * as Plot from "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm";

const data = ${safeData};
const spec = ${safeSpec};
const marks = buildMarks(spec, data);

const chart = Plot.plot({
  width: 640,
  marginLeft: (spec.type === "horizontal-bar" || spec.type === "pie") ? 180 : 60,
  marginBottom: data.length > 8 ? 80 : 40,
  x: {label: spec.xLabel || spec.xKey, tickRotate: spec.type !== "horizontal-bar" && data.length > 8 ? -45 : 0},
  y: {label: spec.yLabel || (spec.series[0]?.name ?? ""), grid: true},
  marks,
  color: (spec.type === "pie" || spec.type === "heatmap") ? {legend: true} : undefined,
});
document.getElementById("chart").appendChild(chart);

function sortOpt(sort, axis) {
  if (sort === "desc") return {[axis]: "-" + (axis === "x" ? "y" : "x")};
  if (sort === "asc") return {[axis]: axis === "x" ? "y" : "x"};
  return undefined;
}

function buildMarks(spec, chartData) {
  if (spec.maxCategories && chartData.length > spec.maxCategories) {
    chartData = chartData.slice(0, spec.maxCategories);
  }
  const {type, xKey, series, sort} = spec;
  const m = [];

  if (type === "horizontal-bar") {
    for (const s of series) {
      m.push(Plot.barX(chartData, {y: xKey, x: s.dataKey, fill: s.color || "steelblue",
        tip: true, sort: sortOpt(sort, "y")}));
    }
    return m;
  }

  if (type === "line") {
    for (const s of series) {
      m.push(Plot.lineY(chartData, {x: xKey, y: s.dataKey, stroke: s.color || "steelblue", tip: true}));
      m.push(Plot.dot(chartData, {x: xKey, y: s.dataKey, fill: s.color || "steelblue", r: 3}));
    }
    return m;
  }

  if (type === "scatter") {
    for (const s of series) {
      m.push(Plot.dot(chartData, {x: xKey, y: s.dataKey, fill: s.color || "steelblue", tip: true, r: 4}));
    }
    return m;
  }

  if (type === "pie") {
    for (const s of series) {
      m.push(Plot.barX(chartData, {y: xKey, x: s.dataKey, fill: xKey, tip: true, sort: {y: "-x"}}));
    }
    return m;
  }

  if (type === "heatmap" && series.length >= 2) {
    m.push(Plot.cell(chartData, {x: xKey, y: series[0].dataKey, fill: series[1].dataKey, tip: true}));
    return m;
  }

  // bar, grouped-bar, stacked-bar, histogram, default
  for (const s of series) {
    m.push(Plot.barY(chartData, {x: xKey, y: s.dataKey, fill: s.color || "steelblue",
      tip: true, sort: sortOpt(sort, "x")}));
  }
  m.push(Plot.ruleY([0]));
  return m;
}

window.exportSvg = function() {
  const svg = document.querySelector("#chart svg")?.outerHTML;
  if (!svg) return;
  const blob = new Blob([svg], {type: "image/svg+xml"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "${fileSlug}.svg";
  a.click();
  URL.revokeObjectURL(a.href);
};

window.exportCsv = function() {
  if (!data || !data.length) return;
  const keys = Object.keys(data[0]);
  const csv = [keys.join(","), ...data.map(r => keys.map(k => JSON.stringify(r[k] ?? "")).join(","))].join("\\n");
  const blob = new Blob([csv], {type: "text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "${fileSlug}.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};

// MCP Apps lifecycle
window.parent?.postMessage({type: "ui-lifecycle-iframe-ready"}, "*");
</script>
</body>
</html>`;
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escJson(s: string): string {
	return s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
