import { describe, expect, it } from "vitest";
import type { ApiCatalog, ApiEndpoint } from "./catalog";
import { countByCategory, formatEndpoint, searchEndpoints } from "./search-core";

const ep = (over: Partial<ApiEndpoint> = {}): ApiEndpoint =>
	({
		method: "GET",
		path: "/gene/{id}",
		summary: "Look up a gene by identifier",
		category: "gene",
		...over,
	}) as ApiEndpoint;

describe("searchEndpoints", () => {
	it("returns nothing for an empty query rather than everything", () => {
		// Guards the difference between "no query" and "match all" — the catalog
		// search tool relies on this to route '' / '*' into its own list mode.
		expect(searchEndpoints([ep()], "   ", 10)).toEqual([]);
	});

	it("ranks endpoints matching more query tokens higher", () => {
		const variant = ep({
			path: "/variant/{id}",
			summary: "variant annotation lookup",
			category: "variant",
		});
		const gene = ep();
		const out = searchEndpoints([gene, variant], "variant annotation", 10);
		expect(out[0]).toBe(variant);
	});

	it("excludes endpoints matching no token", () => {
		expect(searchEndpoints([ep()], "proteomics", 10)).toEqual([]);
	});

	it("honours maxResults", () => {
		const many = Array.from({ length: 8 }, (_, i) =>
			ep({ path: `/gene/${i}`, summary: "gene gene gene" }),
		);
		expect(searchEndpoints(many, "gene", 3)).toHaveLength(3);
	});

	it("searches parameter names and descriptions, not just the path", () => {
		const withParam = ep({
			path: "/x",
			summary: "unrelated",
			category: "misc",
			queryParams: [
				{
					name: "tissue",
					type: "string",
					required: false,
					description: "GTEx tissue name",
				},
			],
		} as Partial<ApiEndpoint>);
		expect(searchEndpoints([withParam], "tissue", 5)).toEqual([withParam]);
	});
});

describe("formatEndpoint", () => {
	it("renders method, path and summary on the first line", () => {
		expect(formatEndpoint(ep())).toMatch(
			/^GET \/gene\/\{id\} — Look up a gene by identifier/,
		);
	});

	it("surfaces the covering tool so the model prefers it over raw calls", () => {
		const out = formatEndpoint(ep({ coveredByTool: "ensembl_lookup" }));
		expect(out).toContain("also available via tool: ensembl_lookup");
	});

	it("marks required vs optional params and includes enum/default extras", () => {
		const out = formatEndpoint(
			ep({
				pathParams: [
					{ name: "id", type: "string", required: true, description: "Gene ID" },
				],
				queryParams: [
					{
						name: "format",
						type: "string",
						required: false,
						description: "Response format",
						enum: ["full", "condensed"],
						default: "full",
					},
				],
			} as Partial<ApiEndpoint>),
		);
		expect(out).toContain("Path: {id} (string, required)");
		expect(out).toContain("Query: format (string, optional)");
		expect(out).toContain('default: "full"');
		expect(out).toContain('values: ["full","condensed"]');
	});
});

describe("countByCategory", () => {
	it("counts endpoints per category", () => {
		const catalog = {
			name: "T",
			baseUrl: "https://x",
			endpointCount: 3,
			endpoints: [
				ep({ category: "gene" }),
				ep({ category: "gene" }),
				ep({ category: "variant" }),
			],
		} as ApiCatalog;
		expect(countByCategory(catalog)).toEqual([
			{ category: "gene", count: 2 },
			{ category: "variant", count: 1 },
		]);
	});

	it("returns an empty list for an empty catalog", () => {
		expect(
			countByCategory({ endpoints: [] } as unknown as ApiCatalog),
		).toEqual([]);
	});
});
