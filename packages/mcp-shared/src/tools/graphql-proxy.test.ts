import { describe, it, expect } from "vitest";
import { createGraphqlProxyTool } from "./graphql-proxy";
import type { GraphqlFetchFn } from "../codemode/graphql-introspection";
import type { ToolContext, ToolEntry } from "../registry/types";

function makeTool(
	gqlFetch: GraphqlFetchFn,
	opts?: { doNamespace?: unknown; stagingThreshold?: number; workspaceNamespace?: unknown },
): ToolEntry {
	return createGraphqlProxyTool({
		gqlFetch,
		stagingPrefix: "test",
		doNamespace: opts?.doNamespace,
		stagingThreshold: opts?.stagingThreshold,
		workspaceNamespace: opts?.workspaceNamespace,
	});
}

const stubCtx: ToolContext = { sql: () => [] };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Per-server DO namespace that records routed paths and stages successfully. */
function makeServerDo() {
	const calls: string[] = [];
	const ns = {
		idFromName: (n: string) => n,
		get: () => ({
			async fetch(req: Request) {
				const path = new URL(req.url).pathname;
				calls.push(path);
				if (path === "/process")
					return json({ success: true, tables_created: ["t1"], total_rows: 3, input_rows: 3, table_row_counts: { t1: 3 } });
				if (path === "/schema") return json({ success: true, schema: { tables: { t1: { columns: [] } } } });
				if (path === "/register") return json({ success: true });
				return json({ success: false }, 404);
			},
		}),
	} as never;
	return { ns, calls };
}

/** Workspace DO namespace that records routed paths and answers /ws/stage. */
function makeWsDo() {
	const calls: string[] = [];
	const ns = {
		idFromName: (n: string) => n,
		get: () => ({
			async fetch(req: Request) {
				const path = new URL(req.url).pathname;
				calls.push(path);
				if (path === "/ws/stage")
					return json({ success: true, data_access_id: "ws_dai_1", tables: ["test__t1"], row_count: 9 });
				return json({ success: false }, 404);
			},
		}),
	} as never;
	return { ns, calls };
}

/**
 * A GraphQL data payload that exceeds the 30KB staging threshold.
 * Includes a small scalar sibling (`count` — preserved onto the envelope) and a
 * key that collides with an envelope field (`total_rows` — skipped via `continue`),
 * so the envelope-scalar-preservation branch is exercised.
 */
function largeGqlData() {
	return {
		count: 500,
		total_rows: "collides-with-envelope-field",
		genes: { nodes: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `gene-${i}-${"x".repeat(80)}` })) },
	};
}

describe("createGraphqlProxyTool — workspace-aware staging (ADR-006 Phase 0)", () => {
	const bigFetch: GraphqlFetchFn = async () => ({ data: largeGqlData() });

	it("auto-stages large responses into the per-server DO by default", async () => {
		const { ns, calls } = makeServerDo();
		const tool = makeTool(bigFetch, { doNamespace: ns });
		const res = (await tool.handler({ query: "{ genes { nodes { id name } } }" }, stubCtx)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(String(res.data_access_id)).toMatch(/^test_/);
		expect(calls).toContain("/process");
		// Small scalar siblings are preserved onto the staging envelope...
		expect(res.count).toBe(500);
		// ...but a sibling that collides with an envelope field is NOT overwritten.
		expect(res.total_rows).not.toBe("collides-with-envelope-field");
	});

	it("routes large responses into the WorkspaceDO when ctx.workspace + workspaceNamespace are set", async () => {
		const server = makeServerDo();
		const ws = makeWsDo();
		const tool = makeTool(bigFetch, { doNamespace: server.ns, workspaceNamespace: ws.ns });
		const ctx: ToolContext = { sql: () => [], workspace: "W" };
		const res = (await tool.handler({ query: "{ genes { nodes { id name } } }" }, ctx)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.data_access_id).toBe("ws_dai_1");
		expect(ws.calls).toContain("/ws/stage");
		expect(server.calls).not.toContain("/process");
	});

	it("ignores ctx.workspace when no workspaceNamespace is wired (per-server staging)", async () => {
		const server = makeServerDo();
		const tool = makeTool(bigFetch, { doNamespace: server.ns });
		const ctx: ToolContext = { sql: () => [], workspace: "W" };
		const res = (await tool.handler({ query: "{ genes { nodes { id name } } }" }, ctx)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(server.calls).toContain("/process");
	});

	it("stages array-shaped data without attempting envelope-scalar preservation", async () => {
		// When response.data is itself an array, preserveEnvelopeScalars early-returns
		// (it only mines plain objects) — staging still succeeds.
		const arrayData = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `row-${i}-${"x".repeat(80)}` }));
		const arrFetch: GraphqlFetchFn = async () => ({ data: arrayData as never });
		const { ns } = makeServerDo();
		const tool = makeTool(arrFetch, { doNamespace: ns });
		const res = (await tool.handler({ query: "{ rows }" }, stubCtx)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(String(res.data_access_id)).toMatch(/^test_/);
	});

	it("summarizes the staged tables: zero, single, and multiple", async () => {
		// Drive the buildStagedTableSummary branches via the /process table count.
		const summaryOf = async (tables_created: string[], table_row_counts: Record<string, number>) => {
			const ns = {
				idFromName: (n: string) => n,
				get: () => ({
					async fetch(req: Request) {
						const path = new URL(req.url).pathname;
						if (path === "/process")
							return json({ success: true, tables_created, total_rows: 3, input_rows: 3, table_row_counts });
						if (path === "/schema") return json({ success: true, schema: {} });
						if (path === "/register") return json({ success: true });
						return json({ success: false }, 404);
					},
				}),
			} as never;
			const tool = makeTool(bigFetch, { doNamespace: ns });
			const res = (await tool.handler({ query: "{ genes { nodes { id } } }" }, stubCtx)) as Record<string, unknown>;
			return String(res.message);
		};

		expect(await summaryOf([], {})).toContain("rows");
		expect(await summaryOf(["only"], { only: 5 })).toContain('table "only" [5 rows]');
		const multi = await summaryOf(["a", "b"], { a: 1 });
		expect(multi).toContain("2 tables:");
		expect(multi).toContain("a [1]");
		expect(multi).toContain("b"); // b has no row count → bare name
	});
});

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
