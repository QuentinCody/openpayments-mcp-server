import { describe, expect, it, vi } from "vitest";

// Capture what the (mocked) executor is handed, so we can assert the isolate
// source + host fn-map reflect the hybrid GraphQL+REST wiring.
const captured = vi.hoisted(
	(): { code: string; fns: Record<string, unknown> } => ({
		code: "",
		fns: {},
	}),
);

vi.mock("./execute-tool", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./execute-tool")>();
	return {
		...actual,
		DynamicWorkerExecutor: class {
			// biome-ignore lint/complexity/noUselessConstructor: mock must accept the real executor's constructor arg
			constructor(_opts: unknown) {}
			async execute(code: string, fns: Record<string, unknown>) {
				captured.code = code;
				captured.fns = fns;
				return { result: { ok: true } };
			}
		},
	};
});

import { createGraphqlExecuteTool } from "./graphql-execute-tool";
import type { TrimmedIntrospection } from "./graphql-introspection";

// Minimal pre-cached introspection so the factory skips the network fetch.
const introspection: TrimmedIntrospection = {
	queryType: { name: "Query" },
	types: [{ name: "Query", kind: "OBJECT", fields: [] }],
};

type Handler = (input: { code: string }, extra: unknown) => Promise<unknown>;

function build(withRest: boolean) {
	return createGraphqlExecuteTool({
		prefix: "rcsb_pdb",
		gqlFetch: async () => ({ data: {} }),
		loader: { get: () => ({}) },
		introspection,
		...(withRest
			? { restApiFetch: async () => ({ status: 200, data: {} }) }
			: {}),
	});
}

async function runHandler(tool: ReturnType<typeof build>): Promise<unknown> {
	let handler: Handler | undefined;
	tool.register({
		tool: (...args: unknown[]) => {
			// register() now registers both `<prefix>_execute` and the sibling
			// `<prefix>_search` (#3) — grab the execute handler specifically (arg 3).
			if (typeof args[0] === "string" && args[0].endsWith("_execute")) {
				handler = args[3] as Handler;
			}
		},
	});
	if (!handler) throw new Error("execute handler was not registered");
	return handler({ code: "return 1" }, {});
}

describe("createGraphqlExecuteTool with restApiFetch (hybrid GraphQL+REST)", () => {
	it("injects the REST capability + registers __api_proxy when restApiFetch is set", async () => {
		captured.code = "";
		captured.fns = {};
		const tool = build(true);
		// Description surfaces the REST surface to the model.
		expect(tool.description).toContain("api.get(path, params)");

		await runHandler(tool);
		// The wrapped isolate source carries the REST override (reassigned api.post).
		expect(captured.code).toContain("REST capability");
		expect(captured.code).toContain("api.post = async function");
		// The host fn-map gained the __api_proxy bridge, alongside the GraphQL proxy.
		expect(Object.keys(captured.fns)).toContain("__api_proxy");
		expect(Object.keys(captured.fns)).toContain("__graphql_proxy");
	});

	it("stays pure-GraphQL (no REST override, no __api_proxy) without restApiFetch", async () => {
		captured.code = "";
		captured.fns = {};
		const tool = build(false);
		expect(tool.description).not.toContain("api.get(path, params)");

		await runHandler(tool);
		expect(captured.code).not.toContain("REST capability");
		expect(Object.keys(captured.fns)).not.toContain("__api_proxy");
		expect(Object.keys(captured.fns)).toContain("__graphql_proxy");
	});
});

describe("createGraphqlExecuteTool registers a sibling _search tool (#3)", () => {
	const richIntro: TrimmedIntrospection = {
		queryType: { name: "Query" },
		types: [
			{
				name: "Query",
				kind: "OBJECT",
				fields: [
					{ name: "target", type: "Target", args: [{ name: "ensemblId", type: "String!" }], description: "Look up a target" },
				],
			},
			{ name: "Target", kind: "OBJECT", fields: [{ name: "approvedSymbol", type: "String" }] },
		],
	};

	it("registers <prefix>_search alongside _execute, and its handler returns matching query roots", async () => {
		const tool = createGraphqlExecuteTool({
			prefix: "ot",
			apiName: "Open Targets",
			gqlFetch: async () => ({ data: {} }),
			loader: { get: () => ({}) },
			introspection: richIntro,
		});
		const names: string[] = [];
		let searchHandler: ((i: { query?: string }) => Promise<unknown>) | undefined;
		tool.register({
			tool: (...args: unknown[]) => {
				names.push(args[0] as string);
				if (args[0] === "ot_search") {
					searchHandler = args[3] as typeof searchHandler;
				}
			},
		});
		expect(names).toContain("ot_execute");
		expect(names).toContain("ot_search");
		if (!searchHandler) throw new Error("search handler not registered");
		const res = (await searchHandler({ query: "target" })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain("target(ensemblId: String!): Target");
	});
});

describe("createGraphqlExecuteTool degrades when the API disables introspection", () => {
	it("still runs the execute handler and injects an 'unavailable' schema", async () => {
		captured.code = "";
		captured.fns = {};
		// No pre-cached introspection; gqlFetch rejects the introspection query the
		// way an Apollo server with `introspection: false` does (errors, no data),
		// so fetchIntrospection throws — the tool must NOT fail every execute (the
		// NCI PDC bug). gql.query against the real API still works.
		const tool = createGraphqlExecuteTool({
			prefix: "pdc",
			apiName: "NCI PDC",
			gqlFetch: async (query: string) =>
				query.includes("__schema")
					? {
							errors: [
								{
									message:
										"GraphQL introspection is not allowed by Apollo Server",
								},
							],
						}
					: { data: { ok: true } },
			loader: { get: () => ({}) },
		});
		const res = (await runHandler(tool)) as { isError?: boolean };
		// Execute succeeds (raw passthrough) instead of dying at introspection.
		expect(res).not.toHaveProperty("isError", true);
		// The injected schema.* helpers report unavailable so isolate code can branch.
		expect(captured.code).toContain("available: false");
	});
});
