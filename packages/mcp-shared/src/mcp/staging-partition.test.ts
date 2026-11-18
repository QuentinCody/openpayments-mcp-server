import { describe, expect, it } from "vitest";
import { createQueryProxyTool } from "../tools/api-proxy";
import { dispatchStagingRequest, isPrivateStagingBinding, publicStagingNamespace } from "./staging-partition";

const method = "labhound/private-call-v1";
const accountA = "a".repeat(64);
const accountB = "b".repeat(64);

function request(owner?: string, rpcMethod = owner ? method : "tools/call") {
	return new Request("https://local.test/mcp", {
		method: "POST",
		headers: owner ? { "mcp-method": method, authorization: `Bearer ${owner}` } : {},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: rpcMethod }),
	});
}

function storage() {
	const rows = new Map<string, string>();
	const raw = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			write: (value: string) => rows.set(id.name, value),
			fetch: async () => Response.json({
				success: true, schema: { tables: rows.has(id.name) ? { rows: {} } : {} },
				results: rows.has(id.name) ? [{ value: rows.get(id.name) }] : [],
				row_count: rows.has(id.name) ? 1 : 0,
			}),
		}),
	};
	return { rows, raw };
}

describe("source staging at MCP ingress", () => {
	it("lets the public HTTP dataset route read a public MCP write while ignoring the old object", async () => {
		const { raw, rows } = storage();
		rows.set("fixture", "old data");
		const publicHttp = publicStagingNamespace(raw as unknown as DurableObjectNamespace);
		const read = () => publicHttp.getByName("fixture").fetch("https://do/schema").then(response => response.json());
		expect(await read()).toMatchObject({ results: [] });
		await dispatchStagingRequest(request(), { SOURCE_DATA_DO: raw }, async (_request, env) => {
			const binding = (env as { SOURCE_DATA_DO: typeof raw }).SOURCE_DATA_DO;
			binding.get(binding.idFromName("fixture")).write("new data");
			return Response.json({});
		});
		expect(await read()).toMatchObject({ results: [{ value: "new data" }] });
		expect(rows.get("fixture")).toBe("old data");
	});

	it("isolates identical dataset, registry, filesystem and workspace names across concurrent calls and public traffic", async () => {
		const { rows, raw } = storage();
		const env = { TEST_DATA_DO: raw, JSON_TO_SQL_DO: raw, WORKSPACE_DO: raw, CODE_MODE_LOADER: {} };
		const names = ["example-result", "the-chat:__registry__", "__fs__", "ws:shared"];
		for (const name of names) rows.set(name, "legacy");
		async function invoke(owner?: string, write?: string) {
			return dispatchStagingRequest(request(owner), env, async (req, bindings) => {
				const scoped = bindings as typeof env;
				expect(scoped.CODE_MODE_LOADER).toBe(env.CODE_MODE_LOADER);
				expect(isPrivateStagingBinding(scoped.TEST_DATA_DO)).toBe(Boolean(owner));
				expect(req.headers.has("authorization")).toBe(false);
				expect((await req.json() as {method: string}).method).toBe("tools/call");
				const values = [];
				for (const [index, name] of names.entries()) {
					const binding = [scoped.TEST_DATA_DO, scoped.JSON_TO_SQL_DO, scoped.TEST_DATA_DO, scoped.WORKSPACE_DO][index];
					const stub = binding.get(binding.idFromName(name));
					if (write) stub.write(write);
					values.push((await (await stub.fetch()).json() as { results: unknown[] }).results);
				}
				// The same proxy that services db.queryStaged() in the source's Code Mode.
				const proxy = createQueryProxyTool({ doNamespace: scoped.TEST_DATA_DO });
				const query = await proxy.handler({ sql: "select value from rows", data_access_id: names[0] }, { sql: () => [] });
				return Response.json({ values, query });
			});
		}
		const [a, b] = await Promise.all([invoke(accountA, "A"), invoke(accountB, "B")]);
		expect(a.headers.get("x-labhound-staging")).toBe("partition-v1");
		expect(b.headers.get("x-labhound-staging")).toBe("partition-v1");
		for (const [owner, expected] of [[accountA, "A"], [accountB, "B"], [undefined, undefined]] as const) {
			const response = await invoke(owner);
			const rows = expected ? [{ value: expected }] : [];
			expect(await response.json()).toMatchObject({ values: names.map(() => rows), query: expected ? { rows } : { __query_error: true } });
		}
	});

	it("rejects malformed private requests before tool dispatch", async () => {
		const unexpected = async () => { throw new Error("unexpected dispatch"); };
		expect((await dispatchStagingRequest(request("invalid"), {}, unexpected)).status).toBe(403);
		expect((await dispatchStagingRequest(request(accountA, "tools/call"), {}, unexpected)).status).toBe(400);
	});

	it("permits only publisher-defined read operations through a published handle", async () => {
		const { raw, rows } = storage();
		rows.set("reference", "published");
		for (const owner of [undefined, accountA]) {
			await dispatchStagingRequest(request(owner), { SOURCE_DATA_DO: raw }, async (_req, bindings) => {
				const namespace = (bindings as { SOURCE_DATA_DO: DurableObjectNamespace }).SOURCE_DATA_DO;
				const stub = namespace.getByName("reference");
				expect((await (await stub.fetch("https://do/schema")).json())).toMatchObject({ results: [{value: "published"}] });
				for (const path of ["/process", "/delete", "/query", "/ingest/promote"]) {
					expect((await stub.fetch("https://do" + path, {method: "POST"})).status).toBe(403);
				}
				expect(stub).not.toHaveProperty("write");
				return Response.json({});
			}, { publishedDataReads: (binding, name) => binding === "SOURCE_DATA_DO" && name === "reference" ? new Set(["GET /schema"]) : undefined });
		}
	});

	it("rejects an ID issued by another binding and omits raw physical-ID access", async () => {
		const { raw } = storage();
		const env = { JSON_TO_SQL_DO: raw, WORKSPACE_DO: raw };
		await dispatchStagingRequest(request(), env, async (_request, bindings) => {
			const scoped = bindings as typeof env;
			expect(scoped.JSON_TO_SQL_DO).not.toHaveProperty("idFromString");
			expect(() => scoped.WORKSPACE_DO.get(scoped.JSON_TO_SQL_DO.idFromName("same"))).toThrow();
			return Response.json({});
		});
	});
});
