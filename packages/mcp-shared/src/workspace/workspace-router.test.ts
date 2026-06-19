import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { stageDataset, workspaceSchema } from "./workspace-ops";
import { handleWorkspaceFetch } from "./workspace-router";

/** node:sqlite presented through the Cloudflare `SqlStorage` exec surface. */
function makeSql() {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			if (/^\s*(select|with|pragma)/i.test(query)) {
				const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
				return {
					toArray: () => rows,
					// Match Cloudflare SqlStorage.one(): THROW unless exactly one row.
					one: () => {
						if (rows.length !== 1) throw new Error(`Expected exactly one result, got ${rows.length}`);
						return rows[0];
					},
					[Symbol.iterator]: () => rows[Symbol.iterator](),
				};
			}
			stmt.run(...(bindings as never[]));
			const empty: Record<string, unknown>[] = [];
			return { toArray: () => empty, one: () => undefined, [Symbol.iterator]: () => empty[Symbol.iterator]() };
		},
	};
}

const chembl = {
	dataset: "chembl",
	data: { results: [{ symbol: "ABL1" }, { symbol: "KIT" }] },
	schemaHints: { tableName: "targets" },
};
const dgidb = {
	dataset: "dgidb",
	data: { results: [{ symbol: "ABL1" }] },
	schemaHints: { tableName: "targets" },
};

const req = (method: string, path: string, body?: unknown) =>
	new Request(`http://do.internal${path}`, {
		method,
		...(body !== undefined
			? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
			: {}),
	});

const readJson = async (res: Response | null) => (await res?.json()) as Record<string, unknown>;

describe("handleWorkspaceFetch — the WorkspaceDO HTTP router", () => {
	it("returns null for non-/ws/ paths so the DO falls back to super.fetch", async () => {
		expect(await handleWorkspaceFetch(makeSql(), req("POST", "/fs/read"))).toBeNull();
	});

	it("stages via POST /ws/stage", async () => {
		const res = await handleWorkspaceFetch(
			makeSql(),
			req("POST", "/ws/stage", {
				dataset: "chembl",
				data: chembl.data,
				schema_hints: { tableName: "targets" },
				source_tool: "chembl_execute",
			}),
		);
		expect(res?.status).toBe(200);
		const json = await readJson(res);
		expect(json.success).toBe(true);
		expect(json.tables).toContain("chembl__targets");
	});

	it("runs stage + clear inside the transaction runner, but never query/schema", async () => {
		const sql = makeSql();
		const calls: string[] = [];
		const spy = <T>(fn: () => T): T => {
			calls.push("tx");
			return fn();
		};
		// /ws/stage is wrapped, and the runner's return value is forwarded to the response.
		const stage = await readJson(
			await handleWorkspaceFetch(
				sql,
				req("POST", "/ws/stage", { dataset: "chembl", data: chembl.data, schema_hints: { tableName: "targets" } }),
				spy,
			),
		);
		expect(stage.tables).toContain("chembl__targets");
		expect(calls).toEqual(["tx"]);
		// /ws/clear is wrapped too (its multi-DROP becomes atomic).
		await handleWorkspaceFetch(sql, req("POST", "/ws/clear", {}), spy);
		expect(calls).toEqual(["tx", "tx"]);
		// Read-only routes must NOT be wrapped.
		await handleWorkspaceFetch(sql, req("POST", "/ws/query", { sql: "SELECT 1 AS n" }), spy);
		await handleWorkspaceFetch(sql, req("GET", "/ws/schema"), spy);
		expect(calls).toEqual(["tx", "tx"]);
	});

	it("runs a cross-dataset JOIN via POST /ws/query", async () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		stageDataset(sql, dgidb);
		const res = await handleWorkspaceFetch(sql, req("POST", "/ws/query", {
			sql: "SELECT c.symbol FROM chembl__targets c JOIN dgidb__targets d ON c.symbol = d.symbol",
		}));
		const json = await readJson(res);
		expect(json.success).toBe(true);
		expect(json.rows).toEqual([{ symbol: "ABL1" }]);
	});

	it("returns the full catalog via GET /ws/schema", async () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		const json = await readJson(await handleWorkspaceFetch(sql, req("GET", "/ws/schema")));
		expect(json.dataset_count).toBe(1);
	});

	it("scopes GET /ws/schema?dataset=", async () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		stageDataset(sql, dgidb);
		const json = await readJson(await handleWorkspaceFetch(sql, req("GET", "/ws/schema?dataset=dgidb")));
		expect(json.dataset_count).toBe(1);
		expect((json.datasets as Array<{ dataset: string }>)[0].dataset).toBe("dgidb");
	});

	it("clears via POST /ws/clear", async () => {
		const sql = makeSql();
		stageDataset(sql, chembl);
		const json = await readJson(await handleWorkspaceFetch(sql, req("POST", "/ws/clear")));
		expect(json.success).toBe(true);
		expect(workspaceSchema(sql).dataset_count).toBe(0);
	});

	it("404s an unknown /ws/ route", async () => {
		const res = await handleWorkspaceFetch(makeSql(), req("POST", "/ws/bogus"));
		expect(res?.status).toBe(404);
	});

	it("returns 400 with the error message on a bad request", async () => {
		const res = await handleWorkspaceFetch(makeSql(), req("POST", "/ws/stage", { dataset: "***", data: {} }));
		expect(res?.status).toBe(400);
		const json = await readJson(res);
		expect(json.error).toMatch(/Invalid dataset/);
	});
});
