import { afterEach, describe, expect, it, vi } from "vitest";
import { exportCitationPublicJwk, generateCitationKeypair, verifyCitationEnvelope } from "@bio-mcp/provenance-core";
import { clearCitationSigningConfiguration, configureCitationSigning } from "../provenance/provenance";
import { createExecuteTool, DynamicWorkerExecutor } from "./execute-tool";
import { createGraphqlExecuteTool } from "./graphql-execute-tool";
import { resolveOpenApiSpec } from "./openapi-resolver";
import { handleRestExecutorResult } from "./execute-tool-result";
import type { ApiCatalog, ApiFetchFn } from "./catalog";

afterEach(() => { vi.restoreAllMocks(); clearCitationSigningConfiguration(); });
const source = { id: "fixture", name: "Fixture source" };
const catalog: ApiCatalog = { name: "Fixture", baseUrl: "https://fixture.test", endpointCount: 1,
	endpoints: [{ method: "GET", path: "/items", summary: "Get items", category: "items" }] };
const spec = resolveOpenApiSpec({ openapi: "3.0.0", info: { title: "Fixture", version: "1" },
	paths: { "/items": { get: { responses: { "200": { description: "Items" } } } } } });

function setup(kind: "rest" | "openapi" | "graphql", apiFetch: ApiFetchFn = async () => ({ status: 200, data: { answer: 42 } }), preserveApiErrors = false) {
	// Execute generated helpers/programs; only the platform's isolate is replaced.
	const execute = vi.spyOn(DynamicWorkerExecutor.prototype, "execute").mockImplementation(async (code, functions) => {
		const staged: Array<Record<string, unknown>> = [];
		try {
			const run = new Function("codemode", "__stagedResults", "console", `return (${code})();`);
			const result = await run(functions, staged, { log() {}, warn() {} });
			return { result: JSON.parse(JSON.stringify(result)), __stagedResults: staged };
		} catch (error) { return { error: String((error as Error).message), __stagedResults: staged }; }
	});
	const base = { prefix: "fixture", source, loader: { get: () => ({}) } };
	const tool = kind === "graphql" ? createGraphqlExecuteTool({ ...base,
		gqlFetch: async () => ({ data: { answer: 42 } }),
		introspection: { queryType: { name: "Query" }, types: [{ name: "Query", kind: "OBJECT", fields: [] }] } }) :
		createExecuteTool({ ...base, apiFetch, preserveApiErrors, ...(kind === "openapi" ? { openApiSpec: spec } : { catalog }) });
	let handler!: (input: { code: string }, extra: unknown) => Promise<any>;
	tool.register({ tool: (...args: unknown[]) => { if (args[0] === "fixture_execute") handler = args[3] as typeof handler; } });
	return { execute, run: (code: string) => handler({ code }, {}) };
}

async function verify(result: any, code: string, trustStore?: Parameters<typeof verifyCitationEnvelope>[0]["trustStore"]) {
	return verifyCitationEnvelope({ citation: result.structuredContent._meta.citation,
		structuredContent: result.structuredContent, toolArguments: { code }, trustStore });
}

describe.each(["rest", "openapi", "graphql"] as const)("%s caller-code citation", kind => {
	it("verifies the exact submitted source including surrounding whitespace, BOM and comments", async () => {
		const f = setup(kind);
		const code = '\uFEFF \n// Preserve 🧬 source bytes\r\nreturn { answer: 42 }; // tail\n\t';
		const result = await f.run(code);
		expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true, data: { answer: 42 } } });
		expect((await verify(result, code)).verification).toMatchObject({ query: "verified", result: "verified", quarantined: false });
		// Semantically similar code is a different submitted query under the declared scope.
		expect((await verify(result, code.trim())).verification).toMatchObject({ query: "mismatch", quarantined: true });
	});

	it("signs the original query and detects post-signature tampering", async () => {
		const keys = await generateCitationKeypair();
		const publicJwk = await exportCitationPublicJwk(keys.publicKey, "fixture-key");
		configureCitationSigning({ CITATION_SIGNING_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", keys.privateKey)), CITATION_SIGNING_KEY_ID: "fixture-key" });
		const trustStore = { version: 1 as const, servers: { fixture: { require_signature: true, keys: [publicJwk] } } };
		const f = setup(kind, undefined, true);
		const code = " \nreturn { answer: 42 };\n";
		const result = await f.run(code);
		expect((await verify(result, code, trustStore)).verification).toMatchObject({ status: "verified", signature: "verified", query: "verified", result: "verified" });
		const citation = result.structuredContent._meta.citation;
		const tampered = { ...result, structuredContent: { ...result.structuredContent, _meta: { citation: { ...citation, tool: "another_tool" } } } };
		expect((await verify(tampered, code, trustStore)).verification).toMatchObject({ signature: "bad_signature", quarantined: true });
	});

	it("rejects whitespace-only programs before execution", async () => {
		const f = setup(kind);
		expect(await f.run(" \n\t")).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: { success: false, error: { code: "INVALID_ARGUMENTS" } } });
		expect(f.execute).not.toHaveBeenCalled();
	});
});

describe("internal API error preservation", () => {
	it("bounds the text summary while retaining and citing the complete error marker", async () => {
		const marker = { __api_error: true, status: 502, message: "α".repeat(10000), data: { native: true } };
		const code = "return await api.get('/items');";
		const result = await handleRestExecutorResult({ result: marker }, { source, server: "fixture", tool: "fixture_execute", query: code });
		expect(result).toMatchObject({ isError: true, structuredContent: { success: false, data: marker } });
		expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThan(2200);
		expect((await verify(result, code)).verification).toMatchObject({ query: "verified", result: "verified", quarantined: false });
	});

	it.each(["rest", "openapi"] as const)("keeps %s status/evidence and a verifiable original query", async kind => {
		const native = { detail: "native rate limit", retry_after: "60", future: { precision: "1e-500" } };
		const apiFetch = vi.fn(async () => { throw Object.assign(new Error("upstream unavailable"), { status: 429, data: native }); });
		const f = setup(kind, apiFetch, true);
		const code = " \nreturn await api.get('/items');\n";
		const result = await f.run(code);
		expect(result).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: { success: false, data: { __api_error: true, status: 429, data: native } } });
		expect(apiFetch).toHaveBeenCalledTimes(1);
		expect((await verify(result, code)).verification).toMatchObject({ query: "verified", result: "verified", quarantined: false });
	});

	it("lets user code handle an API error without intercepting it", async () => {
		const f = setup("rest", async () => { throw Object.assign(new Error("absent"), { status: 404, data: { code: "absent" } }); }, true);
		const code = "try { return await api.get('/items'); } catch (error) { return { handled: error.status }; }";
		const result = await f.run(code);
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent.data).toEqual({ handled: 404 });
		expect((await verify(result, code)).verification.status).toBe("verified");
	});

	it("keeps ordinary program crashes on the executor error path", async () => {
		const f = setup("rest", undefined, true);
		expect(await f.run("throw new Error('program failed');")).toMatchObject({ isError: true, structuredContent: { success: false, error: { message: "program failed" } } });
	});

	it("retains the default behavior when API evidence capture is not enabled", async () => {
		const f = setup("rest", async () => { throw Object.assign(new Error("unavailable"), { status: 503, data: { native: true } }); });
		expect(await f.run("return await api.get('/items');")).toMatchObject({ isError: true, structuredContent: { success: false, error: { message: expect.stringContaining("unavailable") } } });
	});
});
