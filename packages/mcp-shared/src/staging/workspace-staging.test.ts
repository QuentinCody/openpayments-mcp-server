import { describe, expect, it } from "vitest";
import {
	DO_FETCH_ORIGIN,
	getWorkspaceSchemaFromDo,
	queryWorkspaceFromDo,
	stageIntoWorkspace,
} from "./workspace-staging";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

type Route = (body: unknown, url: URL) => Response | Promise<Response>;

/** A WorkspaceDO namespace stub that records every routed request. */
function makeWsDo(routes: Partial<Record<string, Route>>) {
	const calls: Array<{
		path: string;
		id: string;
		body: unknown;
		search: string;
	}> = [];
	const ns = {
		idFromName: (name: string) => name,
		get: (id: string) => ({
			async fetch(req: Request) {
				const url = new URL(req.url);
				let body: unknown;
				if (req.method === "POST") {
					try {
						body = await req.json();
					} catch {
						body = undefined;
					}
				}
				calls.push({ path: url.pathname, id, body, search: url.search });
				const route = routes[url.pathname];
				if (!route) return json({ success: false, error: "no route" }, 404);
				return route(body, url);
			},
		}),
	};
	return { ns: ns as never, calls };
}

describe("DO_FETCH_ORIGIN", () => {
	it("is a synthetic internal origin (never localhost)", () => {
		expect(DO_FETCH_ORIGIN).toBe("http://do.internal");
		expect(DO_FETCH_ORIGIN).not.toContain("localhost");
	});
});

describe("stageIntoWorkspace", () => {
	it("posts to /ws/stage on idFromName('ws:'+id) and maps the handle", async () => {
		const { ns, calls } = makeWsDo({
			"/ws/stage": () =>
				json({
					success: true,
					dataset: "chembl",
					data_access_id: "chembl_abc",
					tables: ["chembl__targets"],
					row_count: 7,
					evidence_table: "chembl__evidence",
					payload_hash: "sha256:abc",
				}),
		});
		const result = await stageIntoWorkspace(
			{ targets: [{ id: 1 }] },
			{ namespace: ns, id: "W", dataset: "chembl" },
			1234,
			"chembl",
			"fallback_id",
			{ indexes: ["id"] },
			"chembl_search",
		);
		expect(result.dataAccessId).toBe("chembl_abc");
		expect(result.tablesCreated).toEqual(["chembl__targets"]);
		expect(result.totalRows).toBe(7);
		expect(result.schema).toBeNull();
		expect(result._staging.evidence_table).toBe("chembl__evidence");
		expect(result._staging.payload_hash).toBe("sha256:abc");
		expect(result._staging).toMatchObject({
			data_access_id: "chembl_abc",
			tables: ["chembl__targets"],
			primary_table: "chembl__targets",
			payload_size_bytes: 1234,
			query_tool: "chembl_query_data",
		});
		// hit the workspace instance and forwarded hints + source_tool
		const stageCall = calls.find((c) => c.path === "/ws/stage");
		expect(stageCall?.id).toBe("ws:W");
		expect(stageCall?.body).toMatchObject({
			dataset: "chembl",
			schema_hints: { indexes: ["id"] },
			source_tool: "chembl_search",
		});
	});

	it("falls back to the provided data_access_id when the DO omits one", async () => {
		const { ns } = makeWsDo({
			"/ws/stage": () =>
				json({ success: true, tables: ["chembl__t"], row_count: 1 }),
		});
		const result = await stageIntoWorkspace(
			{ a: [1] },
			{ namespace: ns, id: "W", dataset: "chembl" },
			1,
			"chembl",
			"fallback_id",
		);
		expect(result.dataAccessId).toBe("fallback_id");
	});

	it("throws when the workspace reports failure (never silently drops)", async () => {
		const { ns } = makeWsDo({
			"/ws/stage": () => json({ success: false, error: "schema boom" }),
		});
		await expect(
			stageIntoWorkspace(
				{ a: [1] },
				{ namespace: ns, id: "W", dataset: "chembl" },
				1,
				"chembl",
				"fallback_id",
			),
		).rejects.toThrow(/Failed to stage into workspace: schema boom/);
	});

	it("throws with a default message when the body is empty/non-object", async () => {
		const { ns } = makeWsDo({ "/ws/stage": () => json("not-an-object") });
		await expect(
			stageIntoWorkspace(
				{ a: [1] },
				{ namespace: ns, id: "W", dataset: "chembl" },
				1,
				"chembl",
				"fallback_id",
			),
		).rejects.toThrow(/Empty workspace response/);
	});
});

describe("queryWorkspaceFromDo", () => {
	it("posts SQL to /ws/query and returns rows + workspace data_access_id", async () => {
		const { ns, calls } = makeWsDo({
			"/ws/query": (body) =>
				json({
					success: true,
					rows: [{ a: 1 }],
					row_count: 1,
					sql: (body as { sql: string }).sql,
					complete_view: true,
				}),
		});
		const result = await queryWorkspaceFromDo(
			ns,
			"W",
			"SELECT * FROM chembl__t",
			50,
		);
		expect(result.rows).toEqual([{ a: 1 }]);
		expect(result.row_count).toBe(1);
		expect(result.complete_view).toBe(true);
		expect(result.data_access_id).toBe("ws:W");
		const q = calls.find((c) => c.path === "/ws/query");
		expect(q?.id).toBe("ws:W");
		expect(q?.body).toMatchObject({
			sql: "SELECT * FROM chembl__t",
			limit: 50,
		});
	});

	it("defaults row_count from rows length and echoes the input sql when omitted", async () => {
		const { ns } = makeWsDo({
			"/ws/query": () => json({ success: true, rows: [{ a: 1 }, { b: 2 }] }),
		});
		const result = await queryWorkspaceFromDo(ns, "W", "SELECT 1");
		expect(result.row_count).toBe(2);
		expect(result.sql).toBe("SELECT 1");
		expect(result.complete_view).toBe(true);
	});

	it("throws when the workspace query fails", async () => {
		const { ns } = makeWsDo({
			"/ws/query": () => json({ success: false, error: "bad sql" }),
		});
		await expect(queryWorkspaceFromDo(ns, "W", "SELECT 1")).rejects.toThrow(
			/Workspace query failed: bad sql/,
		);
	});
});

describe("getWorkspaceSchemaFromDo", () => {
	it("reads /ws/schema and surfaces dataset catalog", async () => {
		const { ns, calls } = makeWsDo({
			"/ws/schema": () =>
				json({
					success: true,
					dataset_count: 2,
					datasets: [{ dataset: "chembl" }, { dataset: "dgidb" }],
				}),
		});
		const result = await getWorkspaceSchemaFromDo(ns, "W");
		expect(result.workspace_id).toBe("W");
		expect(result.schema.dataset_count).toBe(2);
		expect(result.schema.datasets).toHaveLength(2);
		const s = calls.find((c) => c.path === "/ws/schema");
		expect(s?.search).toBe("");
	});

	it("scopes to a single dataset via the query param", async () => {
		const { ns, calls } = makeWsDo({
			"/ws/schema": () =>
				json({
					success: true,
					dataset_count: 1,
					datasets: [{ dataset: "chembl" }],
				}),
		});
		await getWorkspaceSchemaFromDo(ns, "W", "chembl");
		const s = calls.find((c) => c.path === "/ws/schema");
		expect(s?.search).toBe("?dataset=chembl");
	});

	it("throws when the workspace explicitly reports failure", async () => {
		const { ns } = makeWsDo({
			"/ws/schema": () => json({ success: false, error: "no manifest" }),
		});
		await expect(getWorkspaceSchemaFromDo(ns, "W")).rejects.toThrow(
			/Workspace schema retrieval failed: no manifest/,
		);
	});
});

describe("stageIntoWorkspace — primary_row_count threads into completeness (ADR-006 P2)", () => {
	it("reports INCOMPLETE for a nested page: primary_row_count < upstreamTotal despite inflated row_count", async () => {
		const { ns } = makeWsDo({
			"/ws/stage": () =>
				json({
					success: true,
					data_access_id: "x_1",
					tables: ["x__genes"],
					row_count: 105, // total incl. 100 child rows
					primary_row_count: 5, // top-level records actually fetched
				}),
		});
		const result = await stageIntoWorkspace(
			{ genes: [{ id: 1 }] },
			{ namespace: ns, id: "W", dataset: "x" },
			1,
			"x",
			"fallback_id",
			undefined,
			undefined,
			50, // upstreamTotal between primary (5) and total (105)
		);
		// Pagination verdict uses primary rows → incomplete; total still shown as `returned`.
		expect(result._staging?.completeness).toEqual({
			complete: false,
			total_available: 50,
			returned: 105,
		});
		expect(result.totalRows).toBe(105);
		expect(result.inputRows).toBe(5); // primary threaded to the StageResult input count
	});
});
