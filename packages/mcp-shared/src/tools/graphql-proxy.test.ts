import { describe, expect, it } from "vitest";
import type { GraphqlFetchFn } from "../codemode/graphql-introspection";
import type { ToolContext, ToolEntry } from "../registry/types";
import { createGraphqlProxyTool, inspectGraphqlErrors } from "./graphql-proxy";

function makeTool(
	gqlFetch: GraphqlFetchFn,
	opts?: {
		doNamespace?: unknown;
		stagingThreshold?: number;
		workspaceNamespace?: unknown;
	},
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
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

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
					return json({
						success: true,
						tables_created: ["t1"],
						total_rows: 3,
						input_rows: 3,
						table_row_counts: { t1: 3 },
					});
				if (path === "/schema")
					return json({
						success: true,
						schema: { tables: { t1: { columns: [] } } },
					});
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
					return json({
						success: true,
						data_access_id: "ws_dai_1",
						tables: ["test__t1"],
						row_count: 9,
					});
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
		genes: {
			nodes: Array.from({ length: 500 }, (_, i) => ({
				id: i,
				name: `gene-${i}-${"x".repeat(80)}`,
			})),
		},
	};
}

describe("inspectGraphqlErrors", () => {
	it("returns null when there are no GraphQL errors", () => {
		expect(inspectGraphqlErrors({ data: { gene: { id: 1 } } })).toBeNull();
	});

	it("returns null for an empty errors array", () => {
		// An empty `errors: []` is not a failure — GraphQL only signals rejection
		// with at least one entry. Treating it as one would fail clean responses.
		expect(inspectGraphqlErrors({ data: { gene: { id: 1 } }, errors: [] })).toBeNull();
		expect(inspectGraphqlErrors({ errors: [] })).toBeNull();
	});

	it("reports partial:false for errors WITHOUT data — an upstream failure", () => {
		const info = inspectGraphqlErrors({
			errors: [{ message: "Field 'bogus' doesn't exist" }, { message: "second" }],
		});
		expect(info).toEqual({
			messages: ["Field 'bogus' doesn't exist", "second"],
			partial: false,
		});
	});

	it("reports partial:false when data is explicitly null (errors-only)", () => {
		// The live zincbind failure shape: {"zincsite":null} lives INSIDE data;
		// a top-level `data: null` alongside errors carries no result at all.
		const info = inspectGraphqlErrors({
			data: null,
			errors: [{ message: "Cannot query field" }],
		});
		expect(info?.partial).toBe(false);
	});

	it("reports partial:true for errors ALONGSIDE data", () => {
		const info = inspectGraphqlErrors({
			data: { zincsite: null },
			errors: [{ message: "Deprecated field" }],
		});
		expect(info).toEqual({ messages: ["Deprecated field"], partial: true });
	});

	it("stringifies malformed error entries rather than dropping them", () => {
		const info = inspectGraphqlErrors({ errors: ["plain string", { code: 500 }] });
		expect(info?.messages).toEqual(["plain string", "[object Object]"]);
		expect(info?.partial).toBe(false);
	});

	it("classifies the REAL zincbind rejection as a failure (captured live 2026-07-16)", () => {
		// Verbatim body from https://api.zincbind.net for a query naming a bad field.
		// This is the shape that used to be handed back as `success: true` with a
		// `_meta.citation` stamped on it — the tool could not fail. Pinned here so a
		// passthrough can never go green on it again.
		const live = {
			errors: [
				{
					message: 'Cannot query field "bogusField" on type "ZincSiteType".',
					locations: [{ line: 1, column: 31 }],
				},
			],
		};
		const info = inspectGraphqlErrors(live);
		expect(info?.partial).toBe(false);
		expect(info?.messages).toEqual([
			'Cannot query field "bogusField" on type "ZincSiteType".',
		]);
	});

	it("leaves the REAL zincbind success untouched (captured live 2026-07-16)", () => {
		const live = {
			data: { zincsites: { edges: [{ node: { id: "1QJY-9", family: "H5" } }] } },
		};
		expect(inspectGraphqlErrors(live)).toBeNull();
	});

	it("returns null for non-object / empty bodies", () => {
		expect(inspectGraphqlErrors(null)).toBeNull();
		expect(inspectGraphqlErrors(undefined)).toBeNull();
		expect(inspectGraphqlErrors("errors")).toBeNull();
		expect(inspectGraphqlErrors({})).toBeNull();
		// A non-array `errors` is not the GraphQL error contract.
		expect(inspectGraphqlErrors({ errors: { message: "nope" } })).toBeNull();
	});
});

describe("createGraphqlProxyTool — workspace-aware staging (ADR-006 Phase 0)", () => {
	const bigFetch: GraphqlFetchFn = async () => ({ data: largeGqlData() });

	it("auto-stages large responses into the per-server DO by default", async () => {
		const { ns, calls } = makeServerDo();
		const tool = makeTool(bigFetch, { doNamespace: ns });
		const res = (await tool.handler(
			{ query: "{ genes { nodes { id name } } }" },
			stubCtx,
		)) as Record<string, unknown>;
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
		const tool = makeTool(bigFetch, {
			doNamespace: server.ns,
			workspaceNamespace: ws.ns,
		});
		const ctx: ToolContext = { sql: () => [], workspace: "W" };
		const res = (await tool.handler(
			{ query: "{ genes { nodes { id name } } }" },
			ctx,
		)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.data_access_id).toBe("ws_dai_1");
		expect(ws.calls).toContain("/ws/stage");
		expect(server.calls).not.toContain("/process");
	});

	it("ignores ctx.workspace when no workspaceNamespace is wired (per-server staging)", async () => {
		const server = makeServerDo();
		const tool = makeTool(bigFetch, { doNamespace: server.ns });
		const ctx: ToolContext = { sql: () => [], workspace: "W" };
		const res = (await tool.handler(
			{ query: "{ genes { nodes { id name } } }" },
			ctx,
		)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(server.calls).toContain("/process");
	});

	it("stages array-shaped data without attempting envelope-scalar preservation", async () => {
		// When response.data is itself an array, preserveEnvelopeScalars early-returns
		// (it only mines plain objects) — staging still succeeds.
		const arrayData = Array.from({ length: 500 }, (_, i) => ({
			id: i,
			name: `row-${i}-${"x".repeat(80)}`,
		}));
		const arrFetch: GraphqlFetchFn = async () => ({ data: arrayData as never });
		const { ns } = makeServerDo();
		const tool = makeTool(arrFetch, { doNamespace: ns });
		const res = (await tool.handler({ query: "{ rows }" }, stubCtx)) as Record<
			string,
			unknown
		>;
		expect(res.__staged).toBe(true);
		expect(String(res.data_access_id)).toMatch(/^test_/);
	});

	it("summarizes the staged tables: zero, single, and multiple", async () => {
		// Drive the buildStagedTableSummary branches via the /process table count.
		const summaryOf = async (
			tables_created: string[],
			table_row_counts: Record<string, number>,
		) => {
			const ns = {
				idFromName: (n: string) => n,
				get: () => ({
					async fetch(req: Request) {
						const path = new URL(req.url).pathname;
						if (path === "/process")
							return json({
								success: true,
								tables_created,
								total_rows: 3,
								input_rows: 3,
								table_row_counts,
							});
						if (path === "/schema") return json({ success: true, schema: {} });
						if (path === "/register") return json({ success: true });
						return json({ success: false }, 404);
					},
				}),
			} as never;
			const tool = makeTool(bigFetch, { doNamespace: ns });
			const res = (await tool.handler(
				{ query: "{ genes { nodes { id } } }" },
				stubCtx,
			)) as Record<string, unknown>;
			return String(res.message);
		};

		expect(await summaryOf([], {})).toContain("rows");
		expect(await summaryOf(["only"], { only: 5 })).toContain(
			'table "only" [5 rows]',
		);
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
		const result = await tool.handler(
			{ query: "{ gene { id name } }" },
			stubCtx,
		);
		expect(result).toEqual(mockData);
	});

	it("returns __gql_error when GraphQL errors without data", async () => {
		const tool = makeTool(async () => ({
			errors: [{ message: "Field not found" }],
		}));
		const result = (await tool.handler(
			{ query: "{ bad }" },
			stubCtx,
		)) as Record<string, unknown>;
		expect(result.__gql_error).toBe(true);
		expect(result.message).toBe("Field not found");
		expect(result.errors).toHaveLength(1);
	});

	it("returns data directly with __errors for partial results", async () => {
		const tool = makeTool(async () => ({
			data: { gene: { id: 1 } },
			errors: [{ message: "Deprecated field" }],
		}));
		const result = (await tool.handler(
			{ query: "{ gene { id } }" },
			stubCtx,
		)) as Record<string, unknown>;
		// Data is returned directly (unwrapped), not inside a .data wrapper
		expect(result.gene).toEqual({ id: 1 });
		// Partial errors are attached as __errors
		expect(result.__errors).toHaveLength(1);
	});

	it("returns __gql_error when fetch throws", async () => {
		const tool = makeTool(async () => {
			throw new Error("Network failure");
		});
		const result = (await tool.handler(
			{ query: "{ gene }" },
			stubCtx,
		)) as Record<string, unknown>;
		expect(result.__gql_error).toBe(true);
		expect(result.message).toBe("Network failure");
	});
});

describe("createGraphqlProxyTool — pre-flight validation (T1.2)", () => {
	const introspection = {
		queryType: { name: "Query" },
		types: [
			{
				name: "Query",
				kind: "OBJECT",
				fields: [
					{
						name: "gene",
						type: "Gene",
						args: [{ name: "conceptId", type: "String!" }],
					},
				],
			},
			{
				name: "Gene",
				kind: "OBJECT",
				fields: [{ name: "name", type: "String" }],
			},
		],
	};

	it("blocks a confidently-invalid query locally with ZERO upstream call", async () => {
		let fetched = 0;
		const tool = createGraphqlProxyTool({
			gqlFetch: async () => {
				fetched++;
				return { data: {} };
			},
			stagingPrefix: "test",
			getIntrospection: () => introspection,
		});
		const res = (await tool.handler(
			{ query: `{ gene(name:"EGFR") { bogus } }` },
			stubCtx,
		)) as Record<string, unknown>;
		expect(res.__gql_error).toBe(true);
		expect(res.code).toBe("QUERY_VALIDATION");
		expect(res.preflight).toBe(true);
		expect(String(res.message)).toContain("does not accept argument");
		expect(fetched).toBe(0);
	});

	it("lets a valid query through to upstream", async () => {
		let fetched = 0;
		const tool = createGraphqlProxyTool({
			gqlFetch: async () => {
				fetched++;
				return { data: { gene: { name: "EGFR" } } };
			},
			stagingPrefix: "test",
			getIntrospection: () => introspection,
		});
		const res = (await tool.handler(
			{ query: `{ gene(conceptId:"x") { name } }` },
			stubCtx,
		)) as Record<string, unknown>;
		expect(res).toEqual({ gene: { name: "EGFR" } });
		expect(fetched).toBe(1);
	});

	it("passes through when no introspection is available yet", async () => {
		let fetched = 0;
		const tool = createGraphqlProxyTool({
			gqlFetch: async () => {
				fetched++;
				return { data: { ok: true } };
			},
			stagingPrefix: "test",
			getIntrospection: () => undefined,
		});
		await tool.handler({ query: `{ gene(name:"EGFR") { bogus } }` }, stubCtx);
		expect(fetched).toBe(1);
	});
});

describe("createGraphqlProxyTool — staged columns in envelope (T3.3)", () => {
	it("surfaces a compact { table: [cols] } map on the staging envelope", async () => {
		const ns = {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					const path = new URL(req.url).pathname;
					if (path === "/process")
						return json({
							success: true,
							tables_created: ["genes"],
							total_rows: 3,
							input_rows: 3,
							table_row_counts: { genes: 3 },
						});
					if (path === "/schema")
						return json({
							success: true,
							schema: {
								tables: {
									genes: { columns: [{ name: "id" }, { name: "name" }] },
								},
							},
						});
					if (path === "/register") return json({ success: true });
					return json({ success: false }, 404);
				},
			}),
		} as never;
		const tool = makeTool(async () => ({ data: largeGqlData() }), {
			doNamespace: ns,
		});
		const res = (await tool.handler(
			{ query: "{ genes { nodes { id name } } }" },
			stubCtx,
		)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.columns).toEqual({ genes: ["id", "name"] });
	});
});

describe("createGraphqlProxyTool — passthrough transport-size guards (doc 11)", () => {
	it("does NOT treat an empty errors[] with no data as an error (#10)", async () => {
		const tool = makeTool(async () => ({ errors: [] }));
		const result = await tool.handler({ query: "{ x }" }, stubCtx);
		expect(result).not.toHaveProperty("__gql_error");
		expect(result).toEqual({});
	});

	it("does NOT attach __errors for an empty errors[] alongside data (#10)", async () => {
		const tool = makeTool(async () => ({ data: { gene: { id: 1 } }, errors: [] }));
		const result = (await tool.handler(
			{ query: "{ gene { id } }" },
			stubCtx,
		)) as Record<string, unknown>;
		expect(result).toEqual({ gene: { id: 1 } });
		expect(result).not.toHaveProperty("__errors");
	});

	it("fails loud on an oversized inline success with no staging DO (#5)", async () => {
		const tool = makeTool(async () => ({ data: { blob: "x".repeat(120_000) } }));
		const result = (await tool.handler({ query: "{ blob }" }, stubCtx)) as Record<
			string,
			unknown
		>;
		expect(result.__gql_error).toBe(true);
		expect(result.code).toBe("RESPONSE_TOO_LARGE");
		expect(JSON.stringify(result).length).toBeLessThan(100_000);
	});

	it("sizes the full data+errors envelope, not data alone (#6)", async () => {
		// data (~45KB) and errors (~80KB) each fit, but combined they exceed 100KB.
		const data = {
			rows: Array.from({ length: 400 }, () => ({ v: "z".repeat(100) })),
		};
		const errors = Array.from({ length: 700 }, () => ({
			message: "e".repeat(100),
		}));
		const tool = makeTool(async () => ({ data, errors }));
		const result = (await tool.handler({ query: "{ rows }" }, stubCtx)) as Record<
			string,
			unknown
		>;
		expect(result.__gql_error).toBe(true);
		expect(result.code).toBe("RESPONSE_TOO_LARGE");
		expect(result.incomplete).toBe(true);
		// The error object itself must survive transport, and note the suppressed errors.
		expect(JSON.stringify(result).length).toBeLessThan(100_000);
		expect(String(result.message)).toContain("partial error");
	});
});
