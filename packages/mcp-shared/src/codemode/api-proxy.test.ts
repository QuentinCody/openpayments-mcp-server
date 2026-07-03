import { describe, expect, it } from "vitest";
import {
	buildApiProxySource,
	buildRestApiOverrideSource,
} from "./api-proxy";
import { buildGraphqlProxySource } from "./graphql-proxy";

describe("buildApiProxySource", () => {
	const source = buildApiProxySource();

	it("declares the api object with get/post/query and db.stage/queryStaged", () => {
		expect(source).toContain("var api = {");
		expect(source).toContain("get: async function(path, params)");
		expect(source).toContain("post: async function(path, body, params)");
		expect(source).toContain("query: function(dataAccessId, sql)");
		expect(source).toContain("var db = {");
		expect(source).toContain("stage: function(data, tableNameOrOptions)");
	});

	it("routes API calls through codemode.__api_proxy", () => {
		expect(source).toContain("codemode.__api_proxy");
	});

	it("surfaces the structured drift_hint on api errors (T2.1)", () => {
		expect(source).toContain("result.drift_hint");
		expect(source).toContain("err.driftHint = result.drift_hint");
	});

	it("defines a guiding gql.query stub that points at api.get/api.post (T4.3)", () => {
		expect(source).toContain("var gql = {");
		expect(source).toContain("gql.query is not available on this REST server");
		expect(source).toContain("use api.get");
	});

	it("a staged result throws a guided error on array methods, passes real props (T6.3)", () => {
		// Eval the injected source to get __wrapStaged; codemode is only referenced
		// inside method bodies that we never call here.
		const factory = new Function("__stagedResults", "console", "codemode", `${source}\nreturn __wrapStaged;`);
		const wrapStaged = factory([], { warn: () => {} }, {}) as (raw: unknown) => Record<string, unknown>;
		const staged = wrapStaged({ __staged: true, data_access_id: "uniprot_1", message: "auto-staged" });
		expect(() => (staged as { slice: (n: number) => unknown }).slice(0)).toThrow(/STAGED result OBJECT/);
		expect(() => (staged as { map: (f: unknown) => unknown }).map(() => 0)).toThrow(/not an array/);
		expect(staged.data_access_id).toBe("uniprot_1"); // real props still pass through
	});
});

describe("buildRestApiOverrideSource", () => {
	const source = buildRestApiOverrideSource();

	it("reassigns api.get/api.post WITHOUT redeclaring var api/gql/db/__wrapStaged (composability gotcha)", () => {
		expect(source).toContain("api.get = async function");
		expect(source).toContain("api.post = async function");
		// The whole point of the slim override: it must NOT re-declare these — the
		// GraphQL proxy source already does, and a same-scope redeclaration is a
		// parse error inside the isolate.
		expect(source).not.toContain("var api");
		expect(source).not.toContain("var gql");
		expect(source).not.toContain("var db ");
		expect(source).not.toContain("function __wrapStaged");
	});

	it("routes through codemode.__api_proxy and reuses __wrapStaged", () => {
		expect(source).toContain("codemode.__api_proxy");
		expect(source).toContain("__wrapStaged(result)");
	});

	it("composes with the GraphQL proxy source in ONE isolate scope and POSTs through the host", async () => {
		// This is the real injection order from wrapUserCode: gql proxy, then REST
		// override. If the two redeclared the same vars, new Function would throw a
		// SyntaxError here — so this also guards the redeclaration gotcha at runtime.
		const combined = buildGraphqlProxySource() + buildRestApiOverrideSource();
		const calls: Array<Record<string, unknown>> = [];
		const codemode = {
			__api_proxy: async (args: Record<string, unknown>) => {
				calls.push(args);
				return { ok: true, result_set: [], total_count: 0 };
			},
		};
		const factory = new Function(
			"__stagedResults",
			"console",
			"codemode",
			`${combined}\nreturn { api: api, gql: gql };`,
		);
		const scope = factory([], { warn() {}, log() {} }, codemode) as {
			api: { post: (p: string, b: unknown) => Promise<Record<string, unknown>> };
			gql: { query: (q: string) => Promise<unknown> };
		};
		const out = await scope.api.post("/rcsbsearch/v2/query", { q: 1 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/rcsbsearch/v2/query",
			body: { q: 1 },
		});
		expect(out).toMatchObject({ ok: true });
		// gql.query still exists in the same scope (the GraphQL capability survives).
		expect(typeof scope.gql.query).toBe("function");
	});

	it("throws an API error and wraps a staged response", async () => {
		const combined = buildGraphqlProxySource() + buildRestApiOverrideSource();
		let mode = "error";
		const codemode = {
			__api_proxy: async () =>
				mode === "error"
					? { __api_error: true, status: 400, message: "bad query" }
					: {
							__staged: true,
							data_access_id: "rcsb_pdb_1",
							message: "auto-staged",
						},
		};
		const factory = new Function(
			"__stagedResults",
			"console",
			"codemode",
			`${combined}\nreturn api;`,
		);
		const api = factory([], { warn() {} }, codemode) as {
			post: (p: string, b: unknown) => Promise<Record<string, unknown>>;
		};
		await expect(api.post("/x", {})).rejects.toThrow(/API error 400/);
		mode = "staged";
		const staged = await api.post("/x", {});
		expect(staged.data_access_id).toBe("rcsb_pdb_1");
	});
});
