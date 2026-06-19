import { describe, expect, it } from "vitest";
import { createQueryProxyTool } from "./api-proxy";
import type { ToolContext } from "../registry/types";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A DO namespace whose stub records routed paths and answers via `handler`. */
function makeDo(handler: (path: string) => Response) {
	const calls: string[] = [];
	const ns = {
		idFromName: (n: string) => n,
		get: () => ({
			async fetch(req: Request) {
				const path = new URL(req.url).pathname;
				calls.push(path);
				return handler(path);
			},
		}),
	} as never;
	return { ns, calls };
}

describe("createQueryProxyTool", () => {
	it("routes api.query to the per-server DO by default", async () => {
		const server = makeDo((path) => {
			if (path === "/schema") return json({ success: true, schema: { tables: { t1: { columns: [] } } } });
			if (path === "/query") return json({ success: true, results: [{ a: 1 }], row_count: 1 });
			return json({ success: false }, 404);
		});
		const tool = createQueryProxyTool({ doNamespace: server.ns });
		const ctx: ToolContext = { sql: () => [] };
		const res = (await tool.handler({ data_access_id: "chembl_1", sql: "SELECT * FROM t1" }, ctx)) as Record<
			string,
			unknown
		>;
		expect(res.row_count).toBe(1);
		expect(server.calls).toContain("/query");
	});

	it("routes api.query to the WorkspaceDO when ctx.workspace + workspaceNamespace are set", async () => {
		const ws = makeDo((path) =>
			path === "/ws/query"
				? json({ success: true, rows: [{ gene: "TP63" }], row_count: 1, sql: "SELECT ...", truncated: false })
				: json({ success: false }, 404),
		);
		const server = makeDo(() => json({ success: false }, 404));
		const tool = createQueryProxyTool({ doNamespace: server.ns, workspaceNamespace: ws.ns });
		const ctx: ToolContext = { sql: () => [], workspace: "W" };
		const res = (await tool.handler(
			{ data_access_id: "chembl_1", sql: "SELECT * FROM chembl__targets" },
			ctx,
		)) as Record<string, unknown>;
		expect(res.rows).toEqual([{ gene: "TP63" }]);
		expect(ws.calls).toContain("/ws/query");
		// In workspace mode the per-server DO must NOT be queried.
		expect(server.calls).toEqual([]);
	});

	it("surfaces a workspace query failure as __query_error", async () => {
		const ws = makeDo((path) =>
			path === "/ws/query" ? json({ success: false, error: "bad sql" }) : json({ success: false }, 404),
		);
		const tool = createQueryProxyTool({
			doNamespace: makeDo(() => json({ success: false }, 404)).ns,
			workspaceNamespace: ws.ns,
		});
		const res = (await tool.handler(
			{ data_access_id: "x", sql: "SELECT 1" },
			{ sql: () => [], workspace: "W" },
		)) as Record<string, unknown>;
		expect(res.__query_error).toBe(true);
	});

	it("errors when sql is missing", async () => {
		const tool = createQueryProxyTool({ doNamespace: makeDo(() => json({ success: false }, 404)).ns });
		const res = (await tool.handler({ data_access_id: "x", sql: "" }, { sql: () => [] })) as Record<string, unknown>;
		expect(res.__query_error).toBe(true);
	});

	it("errors when data_access_id is missing (per-server mode)", async () => {
		const tool = createQueryProxyTool({ doNamespace: makeDo(() => json({ success: false }, 404)).ns });
		const res = (await tool.handler({ data_access_id: "", sql: "SELECT 1" }, { sql: () => [] })) as Record<
			string,
			unknown
		>;
		expect(res.__query_error).toBe(true);
	});
});
