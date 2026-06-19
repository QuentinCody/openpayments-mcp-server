import { describe, expect, it } from "vitest";
import { createGetSchemaHandler, createQueryDataHandler } from "./query-handlers";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Route = (body: unknown, url: URL) => Response | Promise<Response>;

function makeDo(routes: Partial<Record<string, Route>>) {
	const calls: Array<{ path: string; id: string; body: unknown }> = [];
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
				calls.push({ path: url.pathname, id, body });
				const route = routes[url.pathname];
				if (!route) return json({ success: false, error: "no route" }, 404);
				return route(body, url);
			},
		}),
	};
	return { ns: ns as never, calls };
}

const okSchema = () => json({ success: true, schema: { tables: { t1: { columns: [] } } } });

describe("createQueryDataHandler — per-server path (unchanged)", () => {
	const handler = createQueryDataHandler("DATA_DO", "civic");

	it("errors when the DO binding is missing", async () => {
		const res = await handler({ data_access_id: "x", sql: "SELECT 1" }, {});
		expect(res.structuredContent).toMatchObject({ success: false, error: { code: "DATA_ACCESS_ERROR" } });
	});

	it("returns success with completeness on a good query", async () => {
		const { ns } = makeDo({ "/schema": okSchema, "/query": () => json({ success: true, results: [{ a: 1 }], row_count: 1, truncated: true, total_matching: 9 }) });
		const res = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t" }, { DATA_DO: ns });
		expect(res.structuredContent).toMatchObject({ success: true });
		expect(JSON.stringify(res)).toContain("row_limit");
	});

	it("maps blocked SQL to INVALID_SQL and validated errors to SQL_VALIDATION_ERROR", async () => {
		const env = { DATA_DO: makeDo({ "/schema": okSchema }).ns };
		const blocked = await handler({ data_access_id: "x", sql: "DROP TABLE t" }, env);
		expect((blocked.structuredContent as { error: { code: string } }).error.code).toBe("INVALID_SQL");

		const validatedNs = makeDo({ "/schema": okSchema, "/query": () => json({ success: false, error: "bad", validated: true }) }).ns;
		const validated = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t" }, { DATA_DO: validatedNs });
		expect((validated.structuredContent as { error: { code: string } }).error.code).toBe("SQL_VALIDATION_ERROR");
	});

	it("maps 'not found' query errors to DATA_ACCESS_ERROR", async () => {
		const nfNs = makeDo({ "/schema": okSchema, "/query": () => json({ success: false, error: "relation not found" }) }).ns;
		const nf = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t" }, { DATA_DO: nfNs });
		expect((nf.structuredContent as { error: { code: string } }).error.code).toBe("DATA_ACCESS_ERROR");
	});

	it("defaults to SQL_EXECUTION_ERROR for a generic query failure", async () => {
		const errNs = makeDo({ "/schema": okSchema, "/query": () => json({ success: false, error: "syntax error near FROM" }) }).ns;
		const res = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t" }, { DATA_DO: errNs });
		expect((res.structuredContent as { error: { code: string } }).error.code).toBe("SQL_EXECUTION_ERROR");
	});

	it("emits a complete:true verdict when a query returns truncated:false", async () => {
		const { ns } = makeDo({ "/schema": okSchema, "/query": () => json({ success: true, results: [{ a: 1 }], row_count: 1, truncated: false, total_matching: 1 }) });
		const res = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t" }, { DATA_DO: ns });
		expect(JSON.stringify(res)).toContain("\"complete\":true");
	});

	it("omits the completeness verdict when truncated is absent", async () => {
		const { ns } = makeDo({ "/schema": okSchema, "/query": () => json({ success: true, results: [{ a: 1 }], row_count: 1 }) });
		const res = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t" }, { DATA_DO: ns });
		expect(res.structuredContent).toMatchObject({ success: true });
		expect(JSON.stringify(res)).not.toContain("completeness");
	});
});

describe("createQueryDataHandler — workspace routing (ADR-006 Phase 0)", () => {
	it("routes to /ws/query when workspace + workspaceNamespace are present", async () => {
		const { ns, calls } = makeDo({ "/ws/query": () => json({ success: true, rows: [{ a: 1 }], row_count: 1, truncated: false }) });
		const handler = createQueryDataHandler("DATA_DO", "chembl", { workspaceNamespace: ns });
		const res = await handler({ workspace: "W", sql: "SELECT * FROM chembl__t" }, {}); // note: no per-server DO binding needed
		expect(res.structuredContent).toMatchObject({ success: true });
		expect(JSON.stringify(res)).toContain("ws:W");
		// per-server /query NOT hit; /ws/query was
		expect(calls.some((c) => c.path === "/ws/query")).toBe(true);
		expect(calls.some((c) => c.path === "/query")).toBe(false);
	});

	it("errors when workspace SQL is missing", async () => {
		const { ns } = makeDo({ "/ws/query": () => json({ success: true, rows: [] }) });
		const handler = createQueryDataHandler("DATA_DO", "chembl", { workspaceNamespace: ns });
		const res = await handler({ workspace: "W" }, {});
		expect(res.structuredContent).toMatchObject({ success: false, error: { code: "SQL_EXECUTION_ERROR" } });
	});

	it("surfaces workspace query failures as an error response", async () => {
		const { ns } = makeDo({ "/ws/query": () => json({ success: false, error: "bad sql" }) });
		const handler = createQueryDataHandler("DATA_DO", "chembl", { workspaceNamespace: ns });
		const res = await handler({ workspace: "W", sql: "SELECT 1" }, {});
		expect((res.structuredContent as { error: { code: string } }).error.code).toBe("SQL_EXECUTION_ERROR");
	});

	it("does NOT route to workspace when only the input id is present (no binding)", async () => {
		const handler = createQueryDataHandler("DATA_DO", "chembl");
		const res = await handler({ workspace: "W", sql: "SELECT 1" }, {});
		// falls through to per-server path → missing binding error
		expect(res.structuredContent).toMatchObject({ success: false, error: { code: "DATA_ACCESS_ERROR" } });
	});
});

describe("createGetSchemaHandler — per-server path (unchanged)", () => {
	const handler = createGetSchemaHandler("DATA_DO", "civic");

	it("errors when the DO binding is missing", async () => {
		const res = await handler({ data_access_id: "x" }, {});
		expect(res.structuredContent).toMatchObject({ success: false });
	});

	it("returns a specific dataset's schema, or an error", async () => {
		const ok = await handler({ data_access_id: "civic_1" }, { DATA_DO: makeDo({ "/schema": okSchema }).ns });
		expect(ok.structuredContent).toMatchObject({ success: true });

		const bad = await handler({ data_access_id: "civic_1" }, { DATA_DO: makeDo({ "/schema": () => json({ success: false, error: "nope" }) }).ns });
		expect(bad.structuredContent).toMatchObject({ success: false, error: { code: "DATA_ACCESS_ERROR" } });
	});

	it("lists datasets for the scope when no id given (empty and populated)", async () => {
		const empty = await handler({}, { DATA_DO: makeDo({ "/list": () => json({ success: true, datasets: [] }) }).ns }, "chat-1");
		expect(JSON.stringify(empty)).toContain("No staged datasets");

		const populated = await handler(
			{},
			{
				DATA_DO: makeDo({
					"/list": () => json({ success: true, datasets: [{ data_access_id: "civic_1", tool_name: "civic_search", tables: ["t1"], total_rows: 5, tool_prefix: "civic", created_at: "now" }] }),
				}).ns,
			},
			"chat-1",
		);
		expect(populated.structuredContent).toMatchObject({ success: true });
		expect(JSON.stringify(populated)).toContain("civic_1");
		expect(JSON.stringify(populated)).toContain("civic_query_data");
	});

	it("reports listing failures", async () => {
		const ns = makeDo({ "/list": () => { throw new Error("registry unreachable"); } }).ns;
		const res = await handler({}, { DATA_DO: ns }, "chat-1");
		expect(res.structuredContent).toMatchObject({ success: false });
	});
});

describe("createGetSchemaHandler — workspace routing (ADR-006 Phase 0)", () => {
	it("routes to /ws/schema when workspace + workspaceNamespace are present", async () => {
		const { ns, calls } = makeDo({ "/ws/schema": () => json({ success: true, dataset_count: 1, datasets: [{ dataset: "chembl" }] }) });
		const handler = createGetSchemaHandler("DATA_DO", "chembl", { workspaceNamespace: ns });
		const res = await handler({ workspace: "W" }, {});
		expect(res.structuredContent).toMatchObject({ success: true });
		expect(JSON.stringify(res)).toContain("chembl");
		expect(calls.some((c) => c.path === "/ws/schema")).toBe(true);
	});

	it("scopes to a single dataset and surfaces workspace errors", async () => {
		const { ns, calls } = makeDo({ "/ws/schema": () => json({ success: true, dataset_count: 1, datasets: [] }) });
		const handler = createGetSchemaHandler("DATA_DO", "chembl", { workspaceNamespace: ns });
		await handler({ workspace: "W", dataset: "chembl" }, {});
		expect(calls.find((c) => c.path === "/ws/schema")).toBeDefined();

		const failNs = makeDo({ "/ws/schema": () => json({ success: false, error: "no manifest" }) }).ns;
		const failHandler = createGetSchemaHandler("DATA_DO", "chembl", { workspaceNamespace: failNs });
		const res = await failHandler({ workspace: "W" }, {});
		expect((res.structuredContent as { error: { code: string } }).error.code).toBe("DATA_ACCESS_ERROR");
	});
});
