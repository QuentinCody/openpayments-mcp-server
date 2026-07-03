import { describe, expect, it } from "vitest";
import type { ApiCatalog } from "../codemode/catalog";
import type { ResolvedSpec } from "../codemode/openapi-resolver";
import {
	buildDriftHint,
	buildKnownEndpointIndex,
	preflightUnknownEndpoint,
} from "./api-proxy-drift";

const catalog: ApiCatalog = {
	name: "Demo",
	endpointCount: 2,
	endpoints: [
		{
			method: "GET",
			path: "/studies/{id}",
			summary: "Get a study",
			pathParams: [{ name: "id" }],
			queryParams: [],
		},
		{
			method: "GET",
			path: "/studies",
			summary: "List studies",
			pathParams: [],
			queryParams: [{ name: "q" }],
		},
	],
} as unknown as ApiCatalog;

describe("buildKnownEndpointIndex", () => {
	it("indexes catalog endpoints with normalized methods and param names", () => {
		const index = buildKnownEndpointIndex(catalog);
		const studyById = index.find((e) => e.path === "/studies/{id}");
		expect(studyById?.method).toBe("GET");
		expect(studyById?.pathParamNames).toEqual(["id"]);
		const list = index.find((e) => e.path === "/studies");
		expect(list?.queryParamNames).toEqual(["q"]);
	});

	it("merges catalog + OpenAPI spec endpoints", () => {
		const spec = {
			info: { title: "S" },
			paths: {
				"/genes/{gid}": {
					get: {
						summary: "gene",
						parameters: [
							{ in: "path", name: "gid" },
							{ in: "query", name: "expand" },
						],
					},
				},
			},
		} as unknown as ResolvedSpec;
		const index = buildKnownEndpointIndex(catalog, spec);
		const gene = index.find((e) => e.path === "/genes/{gid}");
		expect(gene?.pathParamNames).toEqual(["gid"]);
		expect(gene?.queryParamNames).toEqual(["expand"]);
	});

	it("returns an empty index when nothing is provided", () => {
		expect(buildKnownEndpointIndex()).toEqual([]);
	});
});

describe("buildDriftHint", () => {
	const index = buildKnownEndpointIndex(catalog);

	it("returns undefined when there are no known endpoints", () => {
		expect(buildDriftHint("GET", "/x", 404, [])).toBeUndefined();
	});

	it("flags an unknown endpoint and suggests close matches", () => {
		const hint = buildDriftHint("GET", "/studie", 404, index);
		expect(hint?.kind).toBe("unknown_endpoint");
		expect(hint?.message).toContain("Unknown endpoint");
	});

	it("flags a parameter mismatch on a 400 with expected params", () => {
		const hint = buildDriftHint("GET", "/studies", 400, index);
		expect(hint?.kind).toBe("parameter_mismatch");
		expect(hint?.expected_params).toContain("q");
	});

	it("explains a 404 on a parameterized path as a missing resource", () => {
		const hint = buildDriftHint("GET", "/studies/NCT999", 404, index);
		expect(hint?.kind).toBe("contract_changed");
		expect(hint?.message).toContain("Resource not found");
	});

	it("flags a 410 on a matched fixed path as a contract change", () => {
		const hint = buildDriftHint("GET", "/studies", 410, index);
		expect(hint?.kind).toBe("contract_changed");
		expect(hint?.message).toContain("410");
	});

	it("returns undefined for an unremarkable status on a matched endpoint", () => {
		expect(buildDriftHint("GET", "/studies", 200, index)).toBeUndefined();
	});
});

describe("preflightUnknownEndpoint", () => {
	const index = buildKnownEndpointIndex(catalog);

	it("returns undefined when the server passed no catalog/spec", () => {
		expect(
			preflightUnknownEndpoint("GET", "/studies/find", []),
		).toBeUndefined();
	});

	it("lets a real fixed endpoint path through (path match, any method)", () => {
		expect(preflightUnknownEndpoint("POST", "/studies", index)).toBeUndefined();
	});

	it("lets a parameterized resource path through", () => {
		expect(
			preflightUnknownEndpoint("GET", "/studies/NCT123", index),
		).toBeUndefined();
	});

	it("lets a wholly-novel path (no sibling first segment) through to upstream", () => {
		expect(
			preflightUnknownEndpoint("GET", "/genes/lookup", index),
		).toBeUndefined();
	});

	it("blocks a hallucinated leaf near a known endpoint with a structured hint", () => {
		const hint = preflightUnknownEndpoint(
			"GET",
			"/studies/search/advanced",
			index,
		);
		expect(hint?.kind).toBe("unknown_endpoint");
		expect(hint?.message).toContain("Unknown endpoint");
		expect(hint?.suggestions?.length).toBeGreaterThan(0);
	});
});
