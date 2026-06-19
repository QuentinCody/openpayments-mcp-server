import { describe, expect, it } from "vitest";
import {
	buildStageOptions,
	createApiProxyTool,
	createStageProxyTool,
	interpolatePath,
	isRecord,
	validatePath,
} from "./api-proxy";
import type { ApiFetchFn } from "../codemode/catalog";
import type { ToolContext } from "../registry/types";

const baseCtx: ToolContext = { sql: () => [] };

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
					return json({ success: true, data_access_id: "ws_dai_1", tables: ["chembl__t1"], row_count: 9 });
				return json({ success: false }, 404);
			},
		}),
	} as never;
	return { ns, calls };
}

/** A large payload that exceeds the 30KB staging threshold. */
function largePayload() {
	return { count: 500, results: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `row-${i}-${"x".repeat(80)}` })) };
}

describe("path helpers", () => {
	it("validatePath rejects traversal and non-rooted paths", () => {
		expect(() => validatePath("/ok")).not.toThrow();
		expect(() => validatePath("no-slash")).toThrow(/start with/);
		expect(() => validatePath("/../etc")).toThrow(/Dangerous/);
	});

	it("interpolatePath fills path params and keeps the rest as query", () => {
		const { path, queryParams } = interpolatePath("/gene/{id}", { id: "BRCA1", expand: "1" });
		expect(path).toBe("/gene/BRCA1");
		expect(queryParams).toEqual({ expand: "1" });
	});

	it("isRecord narrows plain objects only", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
	});
});

describe("buildStageOptions (ADR-006 Phase 0)", () => {
	it("returns plain per-server options when no workspace is in ctx", () => {
		expect(buildStageOptions(baseCtx, makeWsDo().ns, "chembl", 42)).toEqual({ upstreamTotal: 42 });
	});

	it("returns plain options when ctx.workspace is set but no namespace is wired", () => {
		expect(buildStageOptions({ sql: () => [], workspace: "W" }, undefined, "chembl", 7)).toEqual({ upstreamTotal: 7 });
	});

	it("routes to the workspace when both ctx.workspace and the namespace exist", () => {
		const wsNs = makeWsDo().ns;
		const opts = buildStageOptions({ sql: () => [], workspace: "W" }, wsNs, "chembl", 5);
		expect(opts.upstreamTotal).toBe(5);
		expect(opts.workspace).toMatchObject({ id: "W", dataset: "chembl" });
		expect(opts.workspace?.namespace).toBe(wsNs);
	});

	it("tolerates an undefined ctx", () => {
		expect(buildStageOptions(undefined, makeWsDo().ns, "chembl")).toEqual({ upstreamTotal: undefined });
	});
});

describe("createApiProxyTool", () => {
	const apiFetch: ApiFetchFn = async () => ({ status: 200, data: largePayload() });

	it("returns response data inline when small", async () => {
		const small: ApiFetchFn = async () => ({ status: 200, data: { ok: true } });
		const tool = createApiProxyTool({ apiFetch: small });
		const res = await tool.handler({ method: "GET", path: "/x" }, baseCtx);
		expect(res).toEqual({ ok: true });
	});

	it("auto-stages large responses into the per-server DO", async () => {
		const { ns, calls } = makeServerDo();
		const tool = createApiProxyTool({ apiFetch, doNamespace: ns, stagingPrefix: "chembl" });
		const res = (await tool.handler({ method: "GET", path: "/search" }, baseCtx)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.data_access_id).toMatch(/^chembl_/);
		expect(calls).toContain("/process"); // per-server route hit
	});

	it("routes large responses into the WorkspaceDO when ctx.workspace + workspaceNamespace are set", async () => {
		const server = makeServerDo();
		const ws = makeWsDo();
		const tool = createApiProxyTool({ apiFetch, doNamespace: server.ns, stagingPrefix: "chembl", workspaceNamespace: ws.ns });
		const res = (await tool.handler({ method: "GET", path: "/search" }, { sql: () => [], workspace: "W" })) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.data_access_id).toBe("ws_dai_1");
		// workspace /ws/stage hit; per-server /process NOT hit
		expect(ws.calls).toContain("/ws/stage");
		expect(server.calls).not.toContain("/process");
	});

	it("returns an __api_error with a drift hint on fetch failure", async () => {
		const failing: ApiFetchFn = async () => {
			const e = new Error("boom") as Error & { status: number };
			e.status = 404;
			throw e;
		};
		const tool = createApiProxyTool({
			apiFetch: failing,
			catalog: { name: "C", endpointCount: 1, endpoints: [{ method: "GET", path: "/known", summary: "k", pathParams: [], queryParams: [] }] } as never,
		});
		const res = (await tool.handler({ method: "GET", path: "/unknown" }, baseCtx)) as Record<string, unknown>;
		expect(res.__api_error).toBe(true);
		expect(res.status).toBe(404);
		expect(res.drift_hint).toBeDefined();
	});
});

describe("createStageProxyTool", () => {
	it("stages db.stage() data into the per-server DO", async () => {
		const { ns } = makeServerDo();
		const tool = createStageProxyTool({ doNamespace: ns, stagingPrefix: "chembl" });
		const res = (await tool.handler({ data: [{ a: 1 }] }, baseCtx)) as Record<string, unknown>;
		expect(res.data_access_id).toMatch(/^chembl_/);
		expect(res.tables_created).toEqual(["t1"]);
	});

	it("routes db.stage() into the WorkspaceDO when ctx.workspace + workspaceNamespace are set", async () => {
		const server = makeServerDo();
		const ws = makeWsDo();
		const tool = createStageProxyTool({ doNamespace: server.ns, stagingPrefix: "chembl", workspaceNamespace: ws.ns });
		const res = (await tool.handler({ data: [{ a: 1 }], table_name: "scratch" }, { sql: () => [], workspace: "W" })) as Record<string, unknown>;
		expect(res.data_access_id).toBe("ws_dai_1");
		expect(ws.calls).toContain("/ws/stage");
		expect(server.calls).not.toContain("/process");
	});

	it("errors when data is missing", async () => {
		const tool = createStageProxyTool({ doNamespace: makeServerDo().ns, stagingPrefix: "chembl" });
		const res = (await tool.handler({}, baseCtx)) as Record<string, unknown>;
		expect(res.__stage_error).toBe(true);
	});
});
