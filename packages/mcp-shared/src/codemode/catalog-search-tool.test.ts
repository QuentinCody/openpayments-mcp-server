import { describe, expect, it } from "vitest";
import type { ApiCatalog, ApiEndpoint } from "./catalog";
import { createCatalogSearchTool } from "./catalog-search-tool";

// SAFETY: the factory only reads the fields set here; the rest of ApiEndpoint is
// irrelevant to search/format behaviour, so a partial literal is sound.
const ep = (over: Partial<ApiEndpoint> = {}): ApiEndpoint =>
	({
		method: "GET",
		path: "/gene/{id}",
		summary: "Look up a gene by identifier",
		category: "gene",
		...over,
	}) as ApiEndpoint;

// SAFETY: same reasoning — createCatalogSearchTool touches only these fields.
const catalog = {
	name: "Test API",
	baseUrl: "https://example.invalid",
	endpointCount: 2,
	endpoints: [
		ep(),
		ep({
			path: "/variant/{id}",
			category: "variant",
			// Distinct wording so a "gene" query matches exactly one endpoint.
			summary: "Fetch variant annotations",
		}),
	],
} as ApiCatalog;

type Handler = (input: {
	query: string;
	category?: string;
	max_results?: number;
}) => Promise<{
	content?: Array<{ type: string; text: string }>;
	structuredContent?: {
		success: boolean;
		data: Record<string, unknown>;
	};
}>;

/** Register the tool against a stub server and hand back its handler. */
function handlerFor(cat: ApiCatalog = catalog): Handler {
	const tool = createCatalogSearchTool("test", cat);
	let captured: Handler | undefined;
	tool.register({
		tool: (...args: unknown[]) => {
			captured = args[3] as Handler;
		},
	});
	if (!captured) throw new Error("register did not supply a handler");
	return captured;
}

describe("createCatalogSearchTool", () => {
	it("names the tool <prefix>_search", () => {
		expect(createCatalogSearchTool("test", catalog).name).toBe("test_search");
	});

	it("returns both content and structuredContent when endpoints match", () => {
		return handlerFor()({ query: "gene" }).then((res) => {
			expect(res.content?.[0]?.text).toContain("Found 1 endpoint");
			expect(res.structuredContent?.success).toBe(true);
			expect(res.structuredContent?.data.results_count).toBe(1);
		});
	});

	// REGRESSION: the zero-result branch used to return `content` only. Every REST
	// Code Mode server shares this factory, so a search that matched nothing gave
	// the caller no machine-readable signal at all — no count, no category hints.
	// Measured live across the fleet: 75 of 77 contract violations were this path.
	it("returns structuredContent even when nothing matches", async () => {
		const res = await handlerFor()({ query: "nomatchwhatsoever" });

		expect(res.content?.[0]?.text).toContain("No endpoints found");
		expect(res.structuredContent).toBeDefined();
		expect(res.structuredContent?.success).toBe(true);
		expect(res.structuredContent?.data.results_count).toBe(0);
		expect(res.structuredContent?.data.endpoints).toEqual([]);
	});

	it("reports the query and category back in the zero-result payload", async () => {
		const res = await handlerFor()({
			query: "nomatchwhatsoever",
			category: "gene",
		});
		expect(res.structuredContent?.data.query).toBe("nomatchwhatsoever");
		expect(res.structuredContent?.data.category).toBe("gene");
	});

	it("offers available categories as machine-readable recovery hints", async () => {
		const res = await handlerFor()({ query: "nomatchwhatsoever" });
		expect(res.structuredContent?.data.available_categories).toEqual([
			{ category: "gene", count: 1 },
			{ category: "variant", count: 1 },
		]);
	});

	it("treats '*' as list-all rather than a search term", async () => {
		const res = await handlerFor()({ query: "*" });
		expect(res.structuredContent?.data.results_count).toBe(2);
	});

	it("filters by category", async () => {
		const res = await handlerFor()({ query: "*", category: "variant" });
		expect(res.structuredContent?.data.results_count).toBe(1);
	});

	it("caps max_results at 25", async () => {
		// SAFETY: partial endpoints, as above.
		const big = {
			name: "Big",
			baseUrl: "https://example.invalid",
			endpointCount: 40,
			endpoints: Array.from({ length: 40 }, (_, i) =>
				ep({ path: `/gene/${i}` }),
			),
		} as ApiCatalog;
		const res = await handlerFor(big)({ query: "*", max_results: 999 });
		expect(res.structuredContent?.data.results_count).toBe(25);
	});
});
