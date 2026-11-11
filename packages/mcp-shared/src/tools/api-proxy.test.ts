import { describe, expect, it } from "vitest";
import type { ApiFetchFn } from "../codemode/catalog";
import type { ToolContext } from "../registry/types";
import {
	buildStageOptions,
	createApiProxyTool,
	createStageProxyTool,
	extractStagedColumns,
	interpolatePath,
	isRecord,
	validatePath,
} from "./api-proxy";

const baseCtx: ToolContext = { sql: () => [] };

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
						tables: ["chembl__t1"],
						row_count: 9,
					});
				return json({ success: false }, 404);
			},
		}),
	} as never;
	return { ns, calls };
}

/** A large payload that exceeds the 30KB staging threshold. */
function largePayload() {
	return {
		count: 500,
		results: Array.from({ length: 500 }, (_, i) => ({
			id: i,
			name: `row-${i}-${"x".repeat(80)}`,
		})),
	};
}

describe("path helpers", () => {
	it("validatePath rejects traversal and non-rooted paths", () => {
		expect(() => validatePath("/ok")).not.toThrow();
		expect(() => validatePath("no-slash")).toThrow(/start with/);
		expect(() => validatePath("/../etc")).toThrow(/Dangerous/);
	});

	it("validatePath rejects traversal that is written with encoded dots or backslashes", () => {
		// `new URL("/.%2e/.%2e/other/service", "https://host/api/v1/")` is
		// https://host/other/service: the request leaves the API root.
		const base = "https://host.example/api/v1";
		expect(new URL(`${base}/.%2e/.%2e/other/service`).pathname).toBe("/other/service");
		for (const path of [
			"/.%2e/.%2e/other/service",
			"/%2e./other",
			"/%2E%2e/other",
			"/.%2E/other",
			"/a/%2e%2e",
			"/a/.%2e",
			"/a\\..\\other",
			"/a%5c..%5cother",
			"/a%5C%2e%2e%5Cother",
		]) {
			expect(() => validatePath(path), path).toThrow(/Dangerous/);
		}
	});

	it("validatePath accepts ordinary paths with dots and encoded characters", () => {
		for (const path of ["/files/study.v1.2.json", "/v1.2/genes", "/lookup/%2efoo", "/entry/P04637.fasta", "/a/b%20c", "/search?q=1.5..2.5", "/x/a%5Cb"]) {
			expect(() => validatePath(path), path).not.toThrow();
		}
	});

	it("interpolatePath fills path params and keeps the rest as query", () => {
		const { path, queryParams } = interpolatePath("/gene/{id}", {
			id: "BRCA1",
			expand: "1",
		});
		expect(path).toBe("/gene/BRCA1");
		expect(queryParams).toEqual({ expand: "1" });
	});

	it("interpolatePath fills a REPEATED path token", () => {
		// WikiPathways' asset URLs repeat the token: /pathways/{pwId}/{pwId}.json.
		// The param was consumed on the first match, so the second read saw
		// undefined and threw "Missing required path parameter: pwId" for a param
		// that WAS supplied.
		const { path, queryParams } = interpolatePath("/pathways/{pwId}/{pwId}.json", {
			pwId: "WP554",
		});
		expect(path).toBe("/pathways/WP554/WP554.json");
		expect(queryParams).toEqual({});
	});

	it("interpolatePath still throws when a path param is genuinely absent", () => {
		expect(() => interpolatePath("/gene/{id}", {})).toThrow(
			"Missing required path parameter: id",
		);
	});

	it("isRecord narrows plain objects only", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
	});
});

describe("buildStageOptions (ADR-006 Phase 0)", () => {
	it("returns plain per-server options when no workspace is in ctx", () => {
		expect(buildStageOptions(baseCtx, makeWsDo().ns, "chembl", 42)).toEqual({
			upstreamTotal: 42,
		});
	});

	it("returns plain options when ctx.workspace is set but no namespace is wired", () => {
		expect(
			buildStageOptions(
				{ sql: () => [], workspace: "W" },
				undefined,
				"chembl",
				7,
			),
		).toEqual({ upstreamTotal: 7 });
	});

	it("routes to the workspace when both ctx.workspace and the namespace exist", () => {
		const wsNs = makeWsDo().ns;
		const opts = buildStageOptions(
			{ sql: () => [], workspace: "W" },
			wsNs,
			"chembl",
			5,
		);
		expect(opts.upstreamTotal).toBe(5);
		expect(opts.workspace).toMatchObject({ id: "W", dataset: "chembl" });
		expect(opts.workspace?.namespace).toBe(wsNs);
	});

	it("tolerates an undefined ctx", () => {
		expect(buildStageOptions(undefined, makeWsDo().ns, "chembl")).toEqual({
			upstreamTotal: undefined,
		});
	});
});

describe("createApiProxyTool", () => {
  it.each([null, undefined, 200, 0])("honors the adapter's total-count evidence (%s) without changing native count", async upstreamTotal => {
    const {ns} = makeServerDo();
    const data = largePayload();
    const proxy = createApiProxyTool({apiFetch: async () => ({status:200,data,upstreamTotal,
      completeness:{complete:false,returned:500,truncation:{reason:"unknown",detail:"Observed page only"}},
    }),doNamespace:ns,stagingPrefix:"rhea",maxInlineBytes:30720});
    const result = await proxy.handler({method:"GET",path:"/rhea"},baseCtx);
    expect(result).toMatchObject({__staged:true,count:500,_staging:{completeness:{complete:false}}});
    if (upstreamTotal === null) expect(result).not.toHaveProperty("_staging.completeness.total_available");
    else expect(result).toHaveProperty("_staging.completeness.total_available",upstreamTotal ?? 500);
    expect(data.count).toBe(500);
  });

  it("retains adapter-verified partial coverage after successful staging without changing native payloads", async () => {
    const {ns} = makeServerDo();
    const data = {results: [{id: 1, description: "x".repeat(40000)}]};
    const tool = createApiProxyTool({apiFetch: async () => ({status: 200, data,
      completeness: {complete: false, returned: 1, truncation: {reason: "page_limit", detail: "Next page exists"}},
    }), doNamespace: ns, stagingPrefix: "funding", maxInlineBytes: 30720});
    const result = await tool.handler({method: "GET", path: "/awards"}, baseCtx);
    expect(result).toMatchObject({__staged: true, _staging: {completeness: {complete: false, returned: 1, truncation: {reason: "page_limit"}}}});
    expect(data).not.toHaveProperty("completeness");
  });

	const apiFetch: ApiFetchFn = async () => ({
		status: 200,
		data: largePayload(),
	});

	it("returns response data inline when small", async () => {
		const small: ApiFetchFn = async () => ({ status: 200, data: { ok: true } });
		const tool = createApiProxyTool({ apiFetch: small });
		const res = await tool.handler({ method: "GET", path: "/x" }, baseCtx);
		expect(res).toEqual({ ok: true });
	});

	it("keeps a single large record INLINE instead of staging it (T10.1)", async () => {
		const { ns, calls } = makeServerDo();
		// One UniProt-style entity: ~40KB via a nested features array, but it's a
		// single record (no top-level results/hits collection) → should NOT stage.
		const singleEntry: ApiFetchFn = async () => ({
			status: 200,
			data: {
				accession: "Q9BZS1",
				id: "FOXP3_HUMAN",
				features: Array.from({ length: 300 }, (_, i) => ({
					type: "domain",
					desc: `feature-${i}-${"x".repeat(80)}`,
				})),
			},
		});
		const tool = createApiProxyTool({
			apiFetch: singleEntry,
			doNamespace: ns,
			stagingPrefix: "uniprot",
		});
		const res = (await tool.handler(
			{ method: "GET", path: "/Q9BZS1" },
			baseCtx,
		)) as Record<string, unknown>;
		expect(res.__staged).toBeUndefined(); // returned inline
		expect(res.accession).toBe("Q9BZS1");
		expect(calls).not.toContain("/process");
	});

	it("auto-stages large responses into the per-server DO", async () => {
		const { ns, calls } = makeServerDo();
		const tool = createApiProxyTool({
			apiFetch,
			doNamespace: ns,
			stagingPrefix: "chembl",
		});
		const res = (await tool.handler(
			{ method: "GET", path: "/search" },
			baseCtx,
		)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.data_access_id).toMatch(/^chembl_/);
		expect(calls).toContain("/process"); // per-server route hit
	});

	it("routes large responses into the WorkspaceDO when ctx.workspace + workspaceNamespace are set", async () => {
		const server = makeServerDo();
		const ws = makeWsDo();
		const tool = createApiProxyTool({
			apiFetch,
			doNamespace: server.ns,
			stagingPrefix: "chembl",
			workspaceNamespace: ws.ns,
		});
		const res = (await tool.handler(
			{ method: "GET", path: "/search" },
			{ sql: () => [], workspace: "W" },
		)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.data_access_id).toBe("ws_dai_1");
		// workspace /ws/stage hit; per-server /process NOT hit
		expect(ws.calls).toContain("/ws/stage");
		expect(server.calls).not.toContain("/process");
	});

	it("pre-flight blocks a hallucinated leaf near a known endpoint with ZERO upstream call (T1.1)", async () => {
		let upstreamCalls = 0;
		const counting: ApiFetchFn = async () => {
			upstreamCalls++;
			return { status: 200, data: { ok: true } };
		};
		const tool = createApiProxyTool({
			apiFetch: counting,
			catalog: {
				name: "C",
				endpointCount: 1,
				endpoints: [
					{
						method: "GET",
						path: "/association",
						summary: "a",
						pathParams: [],
						queryParams: [],
					},
				],
			} as never,
		});
		const res = (await tool.handler(
			{ method: "GET", path: "/association/find" },
			baseCtx,
		)) as Record<string, unknown>;
		expect(res.__api_error).toBe(true);
		expect(res.code).toBe("UNKNOWN_ENDPOINT");
		expect(res.preflight).toBe(true);
		expect(res.closest_match).toMatchObject({ path: "/association" });
		expect(upstreamCalls).toBe(0); // never hit the network
	});

	it("pre-flight lets a known endpoint path through to upstream (T1.1)", async () => {
		let upstreamCalls = 0;
		const counting: ApiFetchFn = async () => {
			upstreamCalls++;
			return { status: 200, data: { ok: true } };
		};
		const tool = createApiProxyTool({
			apiFetch: counting,
			catalog: {
				name: "C",
				endpointCount: 1,
				endpoints: [
					{
						method: "GET",
						path: "/association",
						summary: "a",
						pathParams: [],
						queryParams: [],
					},
				],
			} as never,
		});
		const res = await tool.handler(
			{ method: "GET", path: "/association" },
			baseCtx,
		);
		expect(res).toEqual({ ok: true });
		expect(upstreamCalls).toBe(1);
	});

	it("returns an __api_error with a drift hint on fetch failure", async () => {
		const failing: ApiFetchFn = async () => {
			const e = new Error("boom") as Error & { status: number };
			e.status = 404;
			throw e;
		};
		const tool = createApiProxyTool({
			apiFetch: failing,
			catalog: {
				name: "C",
				endpointCount: 1,
				endpoints: [
					{
						method: "GET",
						path: "/known",
						summary: "k",
						pathParams: [],
						queryParams: [],
					},
				],
			} as never,
		});
		const res = (await tool.handler(
			{ method: "GET", path: "/unknown" },
			baseCtx,
		)) as Record<string, unknown>;
		expect(res.__api_error).toBe(true);
		expect(res.status).toBe(404);
		expect(res.incomplete).toBe(true); // T9.6 — failed fetch = incomplete evidence
		expect(res.drift_hint).toBeDefined();
	});

	it("stages a large non-2xx body intact instead of trimming its evidence", async () => {
		const server = makeServerDo();
		const body = { diagnostics: "x".repeat(120_000) };
		const tool = createApiProxyTool({
			apiFetch: async () => ({ status: 502, data: body }),
			doNamespace: server.ns,
			stagingPrefix: "test",
		});
		const res = (await tool.handler(
			{ method: "GET", path: "/failure" },
			baseCtx,
		)) as Record<string, unknown>;
		expect(res).toMatchObject({ __api_error: true, status: 502 });
		expect(res.data).toMatchObject({ __staged: true });
		expect(JSON.stringify(res)).not.toContain("__truncated");
		expect(server.calls).toContain("/process");
	});

	it("fails loud without returning a partial large error body when staging is unavailable", async () => {
		const tool = createApiProxyTool({
			apiFetch: async () => ({
				status: 503,
				data: { diagnostics: "x".repeat(120_000) },
			}),
		});
		const res = (await tool.handler(
			{ method: "GET", path: "/failure" },
			baseCtx,
		)) as Record<string, unknown>;
		expect(res.data).toMatchObject({
			__lossless_error: true,
			code: "LOSSLESS_STAGING_REQUIRED",
			evidence_returned: false,
		});
		expect(res.data).not.toHaveProperty("__truncated");
	});
});

describe("extractStagedColumns (T3.3)", () => {
	it("maps each table to its column names", () => {
		const schema = {
			tables: { studies: { columns: [{ name: "nct_id" }, { name: "title" }] } },
		};
		expect(extractStagedColumns(schema)).toEqual({
			studies: ["nct_id", "title"],
		});
	});

	it("returns undefined for schemas with no usable columns", () => {
		expect(
			extractStagedColumns({ tables: { t: { columns: [] } } }),
		).toBeUndefined();
		expect(extractStagedColumns(null)).toBeUndefined();
		expect(extractStagedColumns({})).toBeUndefined();
	});
});

describe("over-match warning on the REST staging envelope (T1.3)", () => {
	it("flags a silently-unfiltered huge result set when staged", async () => {
		const { ns } = makeServerDo();
		// Upstream returns the whole corpus (filter no-op'd): huge total, sorting off.
		const overMatched: ApiFetchFn = async () => ({
			status: 200,
			data: {
				meta: {
					total: 2_944_145,
					sorted_by_relevance: false,
					sort_field: null,
				},
				results: Array.from({ length: 100 }, (_, i) => ({
					id: i,
					abstract: "x".repeat(400),
				})),
			},
		});
		const tool = createApiProxyTool({
			apiFetch: overMatched,
			doNamespace: ns,
			stagingPrefix: "nih",
		});
		const res = (await tool.handler(
			{ method: "POST", path: "/v2/projects/search" },
			baseCtx,
		)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect((res.filter_warning as { warning?: string })?.warning).toBe(
			"filter_may_not_have_applied",
		);
		expect(String(res.message)).toContain("filter may not have applied");
	});
});

describe("staged columns on the REST envelope (T3.3)", () => {
	it("includes a { table: [cols] } map when staging a large response", async () => {
		const ns = {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					const path = new URL(req.url).pathname;
					if (path === "/process")
						return json({
							success: true,
							tables_created: ["studies"],
							total_rows: 3,
							input_rows: 3,
							table_row_counts: { studies: 3 },
						});
					if (path === "/schema")
						return json({
							success: true,
							schema: {
								tables: {
									studies: { columns: [{ name: "nct_id" }, { name: "title" }] },
								},
							},
						});
					if (path === "/register") return json({ success: true });
					return json({ success: false }, 404);
				},
			}),
		} as never;
		const big: ApiFetchFn = async () => ({ status: 200, data: largePayload() });
		const tool = createApiProxyTool({
			apiFetch: big,
			doNamespace: ns,
			stagingPrefix: "ctgov",
		});
		const res = (await tool.handler(
			{ method: "GET", path: "/studies" },
			baseCtx,
		)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.columns).toEqual({ studies: ["nct_id", "title"] });
	});
});

describe("createStageProxyTool", () => {
	it("stages db.stage() data into the per-server DO", async () => {
		const { ns } = makeServerDo();
		const tool = createStageProxyTool({
			doNamespace: ns,
			stagingPrefix: "chembl",
		});
		const res = (await tool.handler({ data: [{ a: 1 }] }, baseCtx)) as Record<
			string,
			unknown
		>;
		expect(res.data_access_id).toMatch(/^chembl_/);
		expect(res.tables_created).toEqual(["t1"]);
	});

	it("routes db.stage() into the WorkspaceDO when ctx.workspace + workspaceNamespace are set", async () => {
		const server = makeServerDo();
		const ws = makeWsDo();
		const tool = createStageProxyTool({
			doNamespace: server.ns,
			stagingPrefix: "chembl",
			workspaceNamespace: ws.ns,
		});
		const res = (await tool.handler(
			{ data: [{ a: 1 }], table_name: "scratch" },
			{ sql: () => [], workspace: "W" },
		)) as Record<string, unknown>;
		expect(res.data_access_id).toBe("ws_dai_1");
		expect(ws.calls).toContain("/ws/stage");
		expect(server.calls).not.toContain("/process");
	});

	it("errors when data is missing", async () => {
		const tool = createStageProxyTool({
			doNamespace: makeServerDo().ns,
			stagingPrefix: "chembl",
		});
		const res = (await tool.handler({}, baseCtx)) as Record<string, unknown>;
		expect(res.__stage_error).toBe(true);
	});
});
