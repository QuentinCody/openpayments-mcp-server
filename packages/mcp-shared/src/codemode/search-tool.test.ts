import { describe, expect, it } from "vitest";
import type { ResolvedSpec } from "./openapi-resolver";
import { createOpenApiHelpers, createSearchTool } from "./search-tool";

// A compact OpenAPI-shaped spec that exercises every describeOp branch:
// present/absent operationId, summary, description, tags; parameters with
// schema.type / p.type / neither, in present/absent, required, description,
// named/unnamed; and responses with/without a description.
const SPEC = {
	info: { title: "Test API", version: "1.0" },
	paths: {
		"/studies": {
			get: {
				operationId: "getStudies",
				summary: "List studies",
				description: "Returns studies",
				tags: ["study", "search"],
				parameters: [
					{
						name: "q",
						in: "query",
						required: true,
						schema: { type: "string" },
						description: "query text",
					},
					{ name: "page", in: "query", type: "integer" },
					{},
				],
				responses: {
					"200": { description: "OK" },
					"404": {},
				},
			},
			post: { operationId: "createStudy" },
		},
		"/health": {
			get: { summary: "Health check" },
		},
	},
};

const H = createOpenApiHelpers(JSON.stringify(SPEC));

describe("createOpenApiHelpers › describeOperation/describeEndpoint (describeOp)", () => {
	it("renders every section of a fully-populated operation", () => {
		const out = H.describeOperation("getStudies");
		expect(out).toContain("GET /studies");
		expect(out).toContain("Operation ID: getStudies");
		expect(out).toContain("Summary: List studies");
		expect(out).toContain("Description: Returns studies");
		expect(out).toContain("Tags: study, search");
		expect(out).toContain("Parameters:");
		// schema.type + in + required + description
		expect(out).toContain("q (query, string, required)");
		expect(out).toContain("query text");
		// p.type fallback, not required, no description
		expect(out).toContain("page (query, integer)");
		// unnamed param: name/in/type all fall back
		expect(out).toContain("(unnamed) (unknown, unknown)");
		expect(out).toContain("Responses:");
		expect(out).toContain("200: OK");
		expect(out).toContain("404:");
	});

	it("omits absent sections for a bare operation", () => {
		const out = H.describeOperation("createStudy");
		expect(out).toContain("POST /studies");
		expect(out).toContain("Operation ID: createStudy");
		expect(out).not.toContain("Summary:");
		expect(out).not.toContain("Description:");
		expect(out).not.toContain("Tags:");
		expect(out).not.toContain("Parameters:");
		expect(out).not.toContain("Responses:");
	});

	it("omits Operation ID when the operation has none", () => {
		const out = H.describeOperation("/health");
		expect(out).toContain("GET /health");
		expect(out).toContain("Summary: Health check");
		expect(out).not.toContain("Operation ID:");
	});

	it("returns the missing label for unknown operation/endpoint", () => {
		expect(H.describeOperation("nope")).toBe("Operation not found: nope");
		expect(H.describeEndpoint("/nope", "delete")).toBe(
			"Endpoint not found: DELETE /nope",
		);
	});

	it("describeEndpoint resolves by path + method and defaults to GET", () => {
		expect(H.describeEndpoint("/studies", "post")).toContain("POST /studies");
		expect(H.describeEndpoint("/health")).toContain("GET /health");
	});
});

describe("createOpenApiHelpers › searchPaths", () => {
	it("matches on path, summary and tag text", () => {
		expect(H.searchPaths("health").map((o) => o.path)).toEqual(["/health"]);
		expect(H.searchPaths("studies").map((o) => o.path)).toContain("/studies");
	});

	it("returns nothing when no operation matches", () => {
		expect(H.searchPaths("proteomics")).toEqual([]);
	});

	it("honours maxResults", () => {
		expect(H.searchPaths("e", 1)).toHaveLength(1);
	});

	it("is aliased as searchSpec — the name exposed inside the isolate", () => {
		expect(H.searchSpec("health").map((o) => o.path)).toEqual(["/health"]);
	});
});

describe("createOpenApiHelpers › listTags / listCategories", () => {
	it("counts operations per tag", () => {
		expect(H.listTags()).toEqual(
			expect.arrayContaining([
				{ tag: "study", count: 1 },
				{ tag: "search", count: 1 },
			]),
		);
	});

	it("listCategories mirrors listTags for isolate callers", () => {
		expect(H.listCategories().length).toBeGreaterThan(0);
	});
});

describe("createOpenApiHelpers › getOperation / getEndpoint", () => {
	it("resolves by operationId and by path", () => {
		expect(H.getOperation("getStudies")?.path).toBe("/studies");
		expect(H.getOperation("/health")?.method).toBe("get");
	});

	it("returns null for an unknown operation rather than throwing", () => {
		expect(H.getOperation("nope")).toBeNull();
		expect(H.getEndpoint("/nope", "get")).toBeNull();
	});

	it("exposes the parsed spec under both spec and SPEC", () => {
		expect(H.spec).toBe(H.SPEC);
		expect(H.SPEC.info.title).toBe("Test API");
	});
});

describe("createOpenApiHelpers › malformed input", () => {
	it("throws a wrapped error when the spec JSON is unparseable", () => {
		expect(() => createOpenApiHelpers("{not json")).toThrow();
	});
});

// ---------------------------------------------------------------------------
// OpenAPI-mode <prefix>_search, exercised through the public factory.
// This is the discovery tool every OpenAPI-mode Code Mode server exposes, and
// the first thing a model calls — its contract matters more than most.
// ---------------------------------------------------------------------------

type SearchHandler = (input: {
	code?: string;
	query?: string;
	category?: string;
	max_results?: number;
}) => Promise<{
	content?: Array<{ type: string; text: string }>;
	structuredContent?: { success: boolean; data?: Record<string, unknown> };
	isError?: boolean;
}>;

function openApiHandler(): SearchHandler {
	// SAFETY: createSearchTool only reads spec.info and spec.paths, both present.
	const tool = createSearchTool({
		prefix: "test",
		openApiSpec: SPEC as unknown as ResolvedSpec,
	});
	let captured: SearchHandler | undefined;
	tool.register({
		tool: (...args: unknown[]) => {
			captured = args[3] as SearchHandler;
		},
	});
	if (!captured) throw new Error("register did not supply a handler");
	return captured;
}

describe("createSearchTool › OpenAPI mode", () => {
	it("names the tool <prefix>_search", () => {
		expect(
			createSearchTool({
				prefix: "test",
				openApiSpec: SPEC as unknown as ResolvedSpec,
			}).name,
		).toBe("test_search");
	});

	it("returns content and structuredContent for a keyword hit", async () => {
		const res = await openApiHandler()({ query: "health" });
		expect(res.content?.[0]?.text).toBeTruthy();
		expect(res.structuredContent?.success).toBe(true);
	});

	it("still returns structuredContent when nothing matches", async () => {
		// Same contract the catalog-mode zero-result path had to be fixed to honour.
		const res = await openApiHandler()({ query: "nomatchwhatsoever" });
		expect(res.content?.[0]?.text).toBeTruthy();
		expect(res.structuredContent).toBeDefined();
	});

	it("filters by tag via the category argument", async () => {
		const res = await openApiHandler()({ query: "*", category: "study" });
		expect(res.structuredContent?.success).toBe(true);
	});

	it("evaluates supplied code against the spec", async () => {
		const res = await openApiHandler()({ code: "return listTags().length;" });
		expect(res.structuredContent?.success).toBe(true);
	});

	it("reports a failure rather than throwing when the code is invalid", async () => {
		const res = await openApiHandler()({ code: "this is not valid js(((" });
		expect(res.content?.[0]?.text).toBeTruthy();
		expect(res.structuredContent).toBeDefined();
	});
});

describe("createSearchTool › misconfiguration", () => {
	it("throws when given neither a catalog nor a spec", () => {
		expect(() => createSearchTool({ prefix: "test" })).toThrow(
			/requires either/i,
		);
	});
});
