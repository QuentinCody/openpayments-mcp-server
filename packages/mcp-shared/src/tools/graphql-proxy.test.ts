import { describe, it, expect } from "vitest";
import { createGraphqlProxyTool } from "./graphql-proxy";
import type { GraphqlFetchFn } from "../codemode/graphql-introspection";
import type { ToolEntry } from "../registry/types";

function makeTool(
	gqlFetch: GraphqlFetchFn,
	opts?: { doNamespace?: unknown; stagingThreshold?: number },
): ToolEntry {
	return createGraphqlProxyTool({
		gqlFetch,
		stagingPrefix: "test",
		doNamespace: opts?.doNamespace,
		stagingThreshold: opts?.stagingThreshold,
	});
}

const stubCtx = { sql: () => [] };

describe("createGraphqlProxyTool", () => {
	it("creates a hidden tool named __graphql_proxy", () => {
		const tool = makeTool(async () => ({ data: {} }));
		expect(tool.name).toBe("__graphql_proxy");
		expect(tool.hidden).toBe(true);
	});

	it("returns error when query is empty", async () => {
		const tool = makeTool(async () => ({ data: {} }));
		const result = await tool.handler({ query: "" }, stubCtx);
		expect(result).toHaveProperty("__gql_error", true);
		expect(result).toHaveProperty("message", "query is required");
	});

	it("returns data on successful query", async () => {
		const mockData = { gene: { id: 1, name: "EGFR" } };
		const tool = makeTool(async () => ({ data: mockData }));
		const result = await tool.handler({ query: "{ gene { id name } }" }, stubCtx);
		expect(result).toEqual(mockData);
	});

	it("returns __gql_error when GraphQL errors without data", async () => {
		const tool = makeTool(async () => ({
			errors: [{ message: "Field not found" }],
		}));
		const result = (await tool.handler({ query: "{ bad }" }, stubCtx)) as Record<string, unknown>;
		expect(result.__gql_error).toBe(true);
		expect(result.message).toBe("Field not found");
		expect(result.errors).toHaveLength(1);
	});

	it("returns data directly with __errors for partial results", async () => {
		const tool = makeTool(async () => ({
			data: { gene: { id: 1 } },
			errors: [{ message: "Deprecated field" }],
		}));
		const result = (await tool.handler({ query: "{ gene { id } }" }, stubCtx)) as Record<string, unknown>;
		// Data is returned directly (unwrapped), not inside a .data wrapper
		expect(result.gene).toEqual({ id: 1 });
		// Partial errors are attached as __errors
		expect(result.__errors).toHaveLength(1);
	});

	it("returns __gql_error when fetch throws", async () => {
		const tool = makeTool(async () => {
			throw new Error("Network failure");
		});
		const result = (await tool.handler({ query: "{ gene }" }, stubCtx)) as Record<string, unknown>;
		expect(result.__gql_error).toBe(true);
		expect(result.message).toBe("Network failure");
	});
});
