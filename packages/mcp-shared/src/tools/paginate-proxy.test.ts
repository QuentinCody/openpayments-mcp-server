import { describe, expect, it } from "vitest";
import type { ApiFetchFn } from "../codemode/catalog";
import type { ToolContext } from "../registry/types";
import { createPaginateProxyTool } from "./paginate-proxy";

const ctx: ToolContext = { sql: () => [] };

type FetchRequest = Parameters<ApiFetchFn>[0];

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** apiFetch over a fixed pool with offset/limit semantics; rows carry a name so large pools exceed the staging threshold. */
function mockApiFetch(pool: number) {
	const calls: FetchRequest[] = [];
	const apiFetch: ApiFetchFn = async (request) => {
		calls.push(request);
		const offset = Number(request.params?.offset ?? 0);
		const limit = Number(request.params?.limit ?? 100);
		const all = Array.from({ length: pool }, (_, i) => ({
			id: i,
			name: `item-${i}`,
		}));
		return {
			status: 200,
			data: { count: pool, results: all.slice(offset, offset + limit) },
		};
	};
	return { apiFetch, calls };
}

/** Minimal DO namespace that accepts staging. */
function makeStagingDo() {
	return {
		idFromName: (n: string) => n,
		get: () => ({
			async fetch(req: Request) {
				const path = new URL(req.url).pathname;
				if (path === "/process")
					return json({
						success: true,
						tables_created: ["t1"],
						total_rows: 2000,
						input_rows: 2000,
						table_row_counts: { t1: 2000 },
					});
				if (path === "/schema")
					return json({
						success: true,
						schema: { tables: { t1: { columns: [] } } },
					});
				return json({ success: false }, 404);
			},
		}),
	} as never;
}

describe("createPaginateProxyTool", () => {
	it("returns combined items inline with a completeness verdict", async () => {
		const { apiFetch, calls } = mockApiFetch(12);
		const tool = createPaginateProxyTool({ apiFetch });
		const res = (await tool.handler(
			{ path: "/search", params: { db: "x" }, opts: { pageSize: 5 } },
			ctx,
		)) as Record<string, unknown>;
		expect(res).toMatchObject({
			count: 12,
			pages: 3,
			total_available: 12,
			completeness: { complete: true },
		});
		expect(calls[0]).toMatchObject({
			method: "GET",
			path: "/search",
			params: { db: "x", offset: 0, limit: 5 },
		});
	});

	it("interpolates path params once and paginates the rest", async () => {
		const { apiFetch, calls } = mockApiFetch(3);
		const tool = createPaginateProxyTool({ apiFetch });
		await tool.handler(
			{
				path: "/gene/{id}/variants",
				params: { id: "BRCA1" },
				opts: { pageSize: 10 },
			},
			ctx,
		);
		expect(calls[0].path).toBe("/gene/BRCA1/variants");
		expect(calls[0].params).not.toHaveProperty("id");
	});

	it("auto-stages large combined sets when a DO namespace is configured", async () => {
		const { apiFetch } = mockApiFetch(2000);
		const tool = createPaginateProxyTool({
			apiFetch,
			doNamespace: makeStagingDo(),
			stagingPrefix: "entrez",
		});
		const res = (await tool.handler(
			{ path: "/search", opts: { pageSize: 500 } },
			ctx,
		)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.data_access_id).toMatch(/^entrez_/);
		expect(res.completeness).toMatchObject({ complete: true });
	});

	it("routes large combined sets into the WorkspaceDO when ctx.workspace is set", async () => {
		const { apiFetch } = mockApiFetch(2000);
		const wsCalls: string[] = [];
		const wsNs = {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					const path = new URL(req.url).pathname;
					wsCalls.push(path);
					if (path === "/ws/stage")
						return json({
							success: true,
							data_access_id: "ws_p_1",
							tables: ["entrez__t1"],
							row_count: 2000,
						});
					return json({ success: false }, 404);
				},
			}),
		} as never;
		const tool = createPaginateProxyTool({
			apiFetch,
			doNamespace: makeStagingDo(),
			stagingPrefix: "entrez",
			workspaceNamespace: wsNs,
		});
		const res = (await tool.handler(
			{ path: "/search", opts: { pageSize: 500 } },
			{ sql: () => [], workspace: "W" },
		)) as Record<string, unknown>;
		expect(res.__staged).toBe(true);
		expect(res.data_access_id).toBe("ws_p_1");
		expect(wsCalls).toContain("/ws/stage");
	});

	it("returns __api_error on fetch failure", async () => {
		const apiFetch: ApiFetchFn = async () => {
			const e = new Error("boom") as Error & { status: number };
			e.status = 503;
			throw e;
		};
		const tool = createPaginateProxyTool({ apiFetch });
		const res = (await tool.handler({ path: "/search" }, ctx)) as Record<
			string,
			unknown
		>;
		expect(res.__api_error).toBe(true);
		expect(res.status).toBe(503);
	});

	it("rejects dangerous traversal paths", async () => {
		const { apiFetch } = mockApiFetch(1);
		const tool = createPaginateProxyTool({ apiFetch });
		const res = (await tool.handler({ path: "/../etc/passwd" }, ctx)) as Record<
			string,
			unknown
		>;
		expect(res.__api_error).toBe(true);
	});
});
