import { describe, expect, it } from "vitest";
import {
	createGetSchemaHandler,
	createQueryDataHandler,
	generateDataAccessId,
	getSchemaFromDo,
	queryDataFromDo,
	shouldStage,
	stageToDoAndRespond,
} from "./utils";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Route = (body: unknown, id: string) => Response | Promise<Response>;

function makeDo(routes: Partial<Record<string, Route>>) {
	const calls: Array<{ path: string; id: string; body: unknown }> = [];
	const ns = {
		idFromName: (name: string) => name,
		get: (id: string) => ({
			async fetch(req: Request) {
				const path = new URL(req.url).pathname;
				let body: unknown;
				if (req.method === "POST") {
					try {
						body = await req.json();
					} catch {
						body = undefined;
					}
				}
				calls.push({ path, id, body });
				const route = routes[path];
				if (!route) return json({ success: false, error: "no route" }, 404);
				return route(body, id);
			},
		}),
	};
	return { ns: ns as never, calls };
}

const okProcess = () => json({ success: true, tables_created: ["t1"], total_rows: 5, input_rows: 5, table_row_counts: { t1: 5 } });
const okSchema = () => json({ success: true, schema: { tables: { t1: { columns: [] } } } });

describe("shouldStage", () => {
	it("compares against the 30KB default or a custom threshold", () => {
		expect(shouldStage(40_000)).toBe(true);
		expect(shouldStage(1_000)).toBe(false);
		expect(shouldStage(600, 500)).toBe(true);
	});
});

describe("generateDataAccessId", () => {
	it("builds a prefixed, unique-ish id", () => {
		const id = generateDataAccessId("civic");
		expect(id).toMatch(/^civic_\d+_[a-z0-9]+$/);
		expect(generateDataAccessId("civic")).not.toBe("");
	});
});

describe("stageToDoAndRespond", () => {
	it("stages, fetches schema, and registers when a scope is given", async () => {
		const { ns, calls } = makeDo({ "/process": okProcess, "/schema": okSchema, "/register": () => json({ success: true }) });
		const result = await stageToDoAndRespond(
			{ rows: [1, 2] },
			ns,
			"civic",
			{ indexes: ["id"] },
			{ toolName: "civic_search" },
			"civic",
			"chat-1",
		);
		expect(result.dataAccessId).toMatch(/^civic_/);
		expect(result.tablesCreated).toEqual(["t1"]);
		expect(result.totalRows).toBe(5);
		expect(result._staging).toBeDefined();
		expect(result.schema).toEqual({ tables: { t1: { columns: [] } } });
		expect(calls.some((c) => c.path === "/register")).toBe(true);
		// schema_hints + context forwarded to /process
		const processCall = calls.find((c) => c.path === "/process");
		expect(processCall?.body).toMatchObject({ schema_hints: { indexes: ["id"] }, context: { toolName: "civic_search" } });
	});

	it("does not register when no scope is provided", async () => {
		const { ns, calls } = makeDo({ "/process": okProcess, "/schema": okSchema });
		await stageToDoAndRespond({ rows: [] }, ns, "civic");
		expect(calls.some((c) => c.path === "/register")).toBe(false);
	});

	it("swallows registry write failures", async () => {
		const { ns } = makeDo({
			"/process": okProcess,
			"/schema": okSchema,
			"/register": () => {
				throw new Error("registry down");
			},
		});
		await expect(stageToDoAndRespond({ rows: [] }, ns, "civic", undefined, undefined, undefined, "chat-1")).resolves.toBeDefined();
	});

	it("throws when the DO process step fails", async () => {
		const { ns } = makeDo({ "/process": () => json({ success: false, error: "schema inference failed" }) });
		await expect(stageToDoAndRespond({ rows: [] }, ns, "civic")).rejects.toThrow(/schema inference failed/);
	});

	it("returns null schema when the schema step fails", async () => {
		const { ns } = makeDo({ "/process": okProcess, "/schema": () => json({ success: false }) });
		const result = await stageToDoAndRespond({ rows: [] }, ns, "civic");
		expect(result.schema).toBeNull();
	});

	it("flags pagination incompleteness when upstreamTotal exceeds staged rows", async () => {
		const { ns } = makeDo({ "/process": okProcess, "/schema": okSchema });
		const result = await stageToDoAndRespond(
			{ rows: [1, 2] },
			ns,
			"civic",
			undefined,
			undefined,
			"civic",
			undefined,
			{ upstreamTotal: 50000 },
		);
		expect(result._staging.completeness).toMatchObject({
			complete: false,
			total_available: 50000,
			returned: 5,
			truncation: { reason: "page_limit" },
		});
	});

	it("flags materialization loss when the DO skips rows", async () => {
		const process = () =>
			json({
				success: true,
				tables_created: ["t1"],
				total_rows: 88,
				input_rows: 100,
				table_row_counts: { t1: 88 },
				staging_warnings: { rows_skipped: 12, data_loss_warning: "12 of 100 rows (12.0%) failed to stage." },
			});
		const { ns } = makeDo({ "/process": process, "/schema": okSchema });
		const result = await stageToDoAndRespond({ rows: [] }, ns, "civic");
		expect(result._staging.completeness).toMatchObject({ complete: false, truncation: { reason: "insertion_failure" } });
		expect(result._staging.completeness?.truncation?.detail).toContain("12 of 100");
	});

	it("reports complete when all rows staged and upstream total is met", async () => {
		const { ns } = makeDo({ "/process": okProcess, "/schema": okSchema });
		const result = await stageToDoAndRespond({ rows: [1] }, ns, "civic", undefined, undefined, "civic", undefined, {
			upstreamTotal: 5,
		});
		expect(result._staging.completeness).toMatchObject({ complete: true });
	});

	it("routes to the WorkspaceDO when options.workspace is present (skips per-server /process)", async () => {
		// Per-server DO: would respond to /process — assert it is NEVER hit.
		const { ns: perServerNs, calls: perServerCalls } = makeDo({ "/process": okProcess, "/schema": okSchema, "/register": () => json({ success: true }) });
		// Workspace DO: responds to /ws/stage.
		const { ns: wsNs, calls: wsCalls } = makeDo({
			"/ws/stage": () => json({ success: true, dataset: "chembl", data_access_id: "chembl_ws_1", tables: ["chembl__targets"], row_count: 12 }),
		});

		const result = await stageToDoAndRespond(
			{ targets: [{ id: 1 }] },
			perServerNs,
			"chembl",
			undefined,
			undefined,
			"chembl",
			undefined,
			{ workspace: { namespace: wsNs, id: "W", dataset: "chembl" } },
		);

		// Handle reflects the workspace response, not the per-server okProcess.
		expect(result.dataAccessId).toBe("chembl_ws_1");
		expect(result.tablesCreated).toEqual(["chembl__targets"]);
		expect(result.totalRows).toBe(12);
		expect(result.schema).toBeNull();
		expect(result._staging.query_tool).toBe("chembl_query_data");

		// The workspace /ws/stage path WAS hit; the per-server /process was NOT.
		expect(wsCalls.some((c) => c.path === "/ws/stage")).toBe(true);
		expect(perServerCalls.some((c) => c.path === "/process")).toBe(false);
		expect(perServerCalls.some((c) => c.path === "/register")).toBe(false);
	});
});

describe("queryDataFromDo SQL guards", () => {
	const anyDo = () => makeDo({}).ns;
	it.each([
		["/* */ comments", "SELECT * FROM t /* hi */", /C-style/],
		["multiple statements", "SELECT 1; SELECT 2", /single SQL statement/],
		["DELETE", "DELETE FROM t", /'DELETE' is not allowed/],
		["DROP", "DROP TABLE t", /'DROP' is not allowed/],
		["non-select", "SHOW TABLES", /SELECT\/WITH/],
	])("rejects %s", async (_label, sql, re) => {
		await expect(queryDataFromDo(anyDo(), "civic_1", sql)).rejects.toThrow(re);
	});

	it("does not flag column names that merely contain keywords", async () => {
		const { ns } = makeDo({
			"/schema": okSchema,
			"/query": () => json({ success: true, results: [{ created_at: "x" }], row_count: 1 }),
		});
		await expect(queryDataFromDo(ns, "civic_1", "SELECT created_at, updated_at FROM t")).resolves.toMatchObject({
			row_count: 1,
		});
	});
});

describe("queryDataFromDo execution", () => {
	it("appends LIMIT, probes schema, and returns rows", async () => {
		const { ns, calls } = makeDo({
			"/schema": okSchema,
			"/query": () => json({ success: true, results: [{ a: 1 }], row_count: 1, truncated: true, total_matching: 50 }),
		});
		const result = await queryDataFromDo(ns, "civic_1", "SELECT * FROM t", 25);
		expect(result).toMatchObject({ row_count: 1, truncated: true, total_matching: 50, data_access_id: "civic_1" });
		expect(result.sql).toBe("SELECT * FROM t LIMIT 25");
		expect(result.rows).toEqual([{ a: 1 }]);
		const queryBody = calls.find((c) => c.path === "/query")?.body as { sql: string };
		expect(queryBody.sql).toContain("LIMIT 25");
	});

	it("keeps an existing LIMIT", async () => {
		const { ns } = makeDo({ "/schema": okSchema, "/query": () => json({ success: true, results: [] }) });
		const result = await queryDataFromDo(ns, "civic_1", "SELECT * FROM t LIMIT 5");
		expect(result.sql).toBe("SELECT * FROM t LIMIT 5");
	});

	it("rejects an unknown/empty data_access_id (no user tables) with a 404", async () => {
		const { ns } = makeDo({ "/schema": () => json({ success: true, schema: { tables: { _staging_x: {}, sqlite_seq: {} } } }) });
		await expect(queryDataFromDo(ns, "civic_missing", "SELECT 1")).rejects.toThrow(/Unknown or empty data_access_id/);
	});

	it("continues past a transient (non-404) probe failure", async () => {
		const { ns } = makeDo({
			"/schema": () => json("not-an-object", 500), // probe.ok false → skipped
			"/query": () => json({ success: true, results: [{ a: 1 }] }),
		});
		await expect(queryDataFromDo(ns, "civic_1", "SELECT 1")).resolves.toMatchObject({ row_count: 1 });
	});

	it("surfaces query failures with diagnostics and validated flags", async () => {
		const { ns } = makeDo({
			"/schema": okSchema,
			"/query": () => json({ success: false, error: "syntax error", diagnostics: { line: 1 }, validated: true }),
		});
		await expect(queryDataFromDo(ns, "civic_1", "SELECT * FROM t")).rejects.toMatchObject({
			message: expect.stringContaining("syntax error"),
			validated: true,
		});
	});
});

describe("getSchemaFromDo", () => {
	it("returns the schema for a populated dataset", async () => {
		const { ns } = makeDo({ "/schema": okSchema });
		const result = await getSchemaFromDo(ns, "civic_1");
		expect(result).toMatchObject({ data_access_id: "civic_1", schema: { tables: { t1: { columns: [] } } } });
	});

	it("throws on failure, missing schema, or empty tables", async () => {
		await expect(getSchemaFromDo(makeDo({ "/schema": () => json({ success: false, error: "nope" }) }).ns, "x")).rejects.toThrow(/nope/);
		await expect(getSchemaFromDo(makeDo({ "/schema": () => json({ success: true, schema: {} }) }).ns, "x")).rejects.toThrow(/not found or contains no data/);
		await expect(getSchemaFromDo(makeDo({ "/schema": () => json({ success: true, schema: { tables: {} } }) }).ns, "x")).rejects.toThrow(/no data/);
	});
});

describe("createQueryDataHandler", () => {
	const handler = createQueryDataHandler("DATA_DO", "civic");

	it("errors when the DO binding is missing", async () => {
		const res = await handler({ data_access_id: "x", sql: "SELECT 1" }, {});
		expect(res.structuredContent).toMatchObject({ success: false, error: { code: "DATA_ACCESS_ERROR" } });
	});

	it("returns a success response with meta on a good query", async () => {
		const { ns } = makeDo({ "/schema": okSchema, "/query": () => json({ success: true, results: [{ a: 1 }], row_count: 1, truncated: false }) });
		const res = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t", limit: 10 }, { DATA_DO: ns });
		expect(res.structuredContent).toMatchObject({ success: true });
	});

	it("emits a completeness verdict and maps not-found query errors to DATA_ACCESS_ERROR", async () => {
		// truncated:true → complete:false completeness branch
		const truncNs = makeDo({
			"/schema": okSchema,
			"/query": () => json({ success: true, results: [{ a: 1 }], row_count: 1, truncated: true, total_matching: 99 }),
		}).ns;
		const trunc = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t" }, { DATA_DO: truncNs });
		expect(JSON.stringify(trunc)).toContain("row_limit");

		// a query error whose message contains "not found" maps to DATA_ACCESS_ERROR
		const nfNs = makeDo({ "/schema": okSchema, "/query": () => json({ success: false, error: "relation not found" }) }).ns;
		const nf = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t" }, { DATA_DO: nfNs });
		expect((nf.structuredContent as { error: { code: string } }).error.code).toBe("DATA_ACCESS_ERROR");
	});

	it("maps error messages to codes", async () => {
		const env = { DATA_DO: makeDo({ "/schema": okSchema }).ns };
		const missing = await handler({ sql: "SELECT 1" }, env); // no data_access_id
		expect(missing.structuredContent).toMatchObject({ success: false });

		const blocked = await handler({ data_access_id: "x", sql: "DROP TABLE t" }, env);
		expect((blocked.structuredContent as { error: { code: string } }).error.code).toBe("INVALID_SQL");

		const validatedNs = makeDo({ "/schema": okSchema, "/query": () => json({ success: false, error: "bad", validated: true }) }).ns;
		const validated = await handler({ data_access_id: "civic_1", sql: "SELECT * FROM t" }, { DATA_DO: validatedNs });
		expect((validated.structuredContent as { error: { code: string } }).error.code).toBe("SQL_VALIDATION_ERROR");

		// A 404 from an unknown DAI ("...No staged data found.") doesn't match the
		// "not found"/"not available" substrings, so it falls through to the default.
		const notFoundNs = makeDo({ "/schema": () => json({ success: true, schema: { tables: {} } }) }).ns;
		const notFound = await handler({ data_access_id: "civic_x", sql: "SELECT 1" }, { DATA_DO: notFoundNs });
		expect((notFound.structuredContent as { error: { code: string } }).error.code).toBe("SQL_EXECUTION_ERROR");
	});
});

describe("createGetSchemaHandler", () => {
	const handler = createGetSchemaHandler("DATA_DO", "civic");

	it("errors when the DO binding is missing", async () => {
		const res = await handler({ data_access_id: "x" }, {});
		expect(res.structuredContent).toMatchObject({ success: false });
	});

	it("returns a specific dataset's schema, or an error", async () => {
		const ok = await handler({ data_access_id: "civic_1" }, { DATA_DO: makeDo({ "/schema": okSchema }).ns });
		expect(ok.structuredContent).toMatchObject({ success: true });
		const bad = await handler({ data_access_id: "civic_1" }, { DATA_DO: makeDo({ "/schema": () => json({ success: false, error: "x" }) }).ns });
		expect(bad.structuredContent).toMatchObject({ success: false });
	});

	it("lists staged datasets for the scope (empty and populated)", async () => {
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
	});

	it("reports listing failures", async () => {
		const ns = makeDo({
			"/list": () => {
				throw new Error("registry unreachable");
			},
		}).ns;
		const res = await handler({}, { DATA_DO: ns }, "chat-1");
		expect(res.structuredContent).toMatchObject({ success: false });
	});
});
