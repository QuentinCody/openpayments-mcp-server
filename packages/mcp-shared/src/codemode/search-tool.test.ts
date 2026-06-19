import { describe, expect, it } from "vitest";
import { createOpenApiHelpers } from "./search-tool";

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
					{ name: "q", in: "query", required: true, schema: { type: "string" }, description: "query text" },
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
		expect(H.describeEndpoint("/nope", "delete")).toBe("Endpoint not found: DELETE /nope");
	});

	it("describeEndpoint resolves by path + method and defaults to GET", () => {
		expect(H.describeEndpoint("/studies", "post")).toContain("POST /studies");
		expect(H.describeEndpoint("/health")).toContain("GET /health");
	});
});
