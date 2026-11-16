import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpHandler, McpServer, StatelessMcpWorker } from "./stateless-worker";

const REQUEST_META = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientInfo": {
		name: "shared-adapter-test",
		version: "1.0.0",
	},
	"io.modelcontextprotocol/clientCapabilities": {},
};

function modernRequest(
	method: string,
	params: Record<string, unknown> = {},
	headers: Record<string, string> = {},
) {
	return new Request("https://example.test/mcp", {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-method": method,
			"mcp-protocol-version": "2026-07-28",
			// The 2026-07-28 entry rejects a body whose params.name has no matching header.
			...headers,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method,
			params: { _meta: REQUEST_META, ...params },
		}),
	});
}

function executionContext(): ExecutionContext {
	return {
		waitUntil() {},
		passThroughOnException() {},
		props: {},
	} satisfies ExecutionContext;
}

interface ToolCallBody {
	result?: {
		isError?: boolean;
		content?: Array<{ type: string; text?: string }>;
		structuredContent?: Record<string, unknown>;
	};
}

/**
 * Drives the REAL McpServer through the REAL createMcpHandler; `umls_search` is
 * modelled on the live tool whose required argument is `string`, which is how
 * the fleet sweep hit the SDK's argument validator.
 */
async function callTool(
	args: Record<string, unknown>,
	behaviour: "ok" | "throw" = "ok",
): Promise<ToolCallBody> {
	const handler = createMcpHandler(
		() => {
			const server = new McpServer({ name: "test", version: "1.0.0" });
			server.tool(
				"umls_search",
				"Search UMLS",
				{ string: z.string().min(1) },
				async ({ string }) => {
					if (behaviour === "throw") {
						throw new Error(`umls_search failed: upstream said no`);
					}
					return {
						content: [{ type: "text", text: string }],
						structuredContent: { success: true, data: { string } },
					};
				},
			);
			return server;
		},
		{ route: "/mcp", legacy: "stateless" },
	);
	const response = await handler(
		modernRequest(
			"tools/call",
			{ name: "umls_search", arguments: args },
			{ "mcp-name": "umls_search" },
		),
		{},
		executionContext(),
	);
	return (await response.json()) as ToolCallBody;
}

describe("MCP 2026-07-28 shared adapter", () => {
	it("translates the removed tool() helper into v2 registration", () => {
		const server = new McpServer({ name: "test", version: "1.0.0" });
		server.tool(
			"echo",
			"Echo a value",
			{ value: z.string() },
			async ({ value }) => ({
				content: [{ type: "text", text: value }],
				structuredContent: { value },
			}),
		);

		expect(server.toolInputSchemaJson("echo")).toMatchObject({
			type: "object",
			required: ["value"],
		});
	});

	it("delegates tool() to the prototype registerTool, not the instance one", () => {
		// bio-orchestrator's dual registration replaces BOTH instance methods. When
		// tool() delegated through `this.registerTool`, the two wrappers composed:
		// each alias expanded a second time and the SDK threw
		// "Tool mcp_echo is already registered", taking every request down.
		type Registrar = (name: string, ...args: unknown[]) => unknown;
		const server = new McpServer({ name: "test", version: "1.0.0" });
		const mutable = server as unknown as {
			tool: Registrar;
			registerTool: Registrar;
		};
		const dualize =
			(registrar: Registrar): Registrar =>
			(name, ...args) => {
				let result: unknown;
				for (const alias of [`mcp_${name}`, name]) {
					result = registrar(alias, ...args);
				}
				return result;
			};
		mutable.tool = dualize(mutable.tool.bind(server) as Registrar);
		mutable.registerTool = dualize(
			mutable.registerTool.bind(server) as Registrar,
		);

		server.tool("echo", "Echo a value", { value: z.string() }, async () => ({
			content: [{ type: "text", text: "ok" }],
			structuredContent: { ok: true },
		}));

		expect(server.toolInputSchemaJson("mcp_echo")).toBeDefined();
		expect(server.toolInputSchemaJson("echo")).toBeDefined();
		expect(server.toolInputSchemaJson("mcp_mcp_echo")).toBeUndefined();
	});

	it("serves server/discover without initialize or a session id", async () => {
		const handler = createMcpHandler(
			() => new McpServer({ name: "test", version: "1.0.0" }),
			{ route: "/mcp", legacy: "stateless" },
		);
		const executionContext = {
			waitUntil() {},
			passThroughOnException() {},
			props: {},
		} satisfies ExecutionContext;
		const response = await handler(
			modernRequest("server/discover"),
			{},
			executionContext,
		);
		const body = (await response.json()) as {
			result?: {
				supportedVersions?: string[];
				resultType?: string;
				ttlMs?: number;
				cacheScope?: string;
				_meta?: Record<string, unknown>;
			};
		};

		expect(response.status).toBe(200);
		expect(response.headers.get("mcp-session-id")).toBeNull();
		expect(body.result?.supportedVersions).toContain("2026-07-28");
		expect(body.result?.resultType).toBe("complete");
		expect(body.result?.ttlMs).toBe(300_000);
		expect(body.result?.cacheScope).toBe("private");
		expect(body.result?._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
			name: "test",
			version: "1.0.0",
		});
	});

	it("keeps content + structuredContent when the SDK rejects the arguments", async () => {
		// The exact probe the fleet sweep sent: `query` instead of the required `string`.
		const body = await callTool({ query: "*" });
		const text = body.result?.content?.[0]?.text;

		expect(body.result?.isError).toBe(true);
		expect(text).toContain("Input validation error");
		expect(text).toContain("umls_search");
		expect(body.result?.structuredContent).toEqual({
			success: false,
			error: { code: "INPUT_VALIDATION_ERROR", message: text },
		});
	});

	it("keeps content + structuredContent when the tool handler throws", async () => {
		const body = await callTool({ string: "diabetes" }, "throw");

		expect(body.result?.isError).toBe(true);
		expect(body.result?.content?.[0]?.text).toBe(
			"umls_search failed: upstream said no",
		);
		expect(body.result?.structuredContent).toEqual({
			success: false,
			error: {
				code: "TOOL_EXECUTION_ERROR",
				message: "umls_search failed: upstream said no",
			},
		});
	});

	it("names the code of an SDK output validation error", () => {
		// The SDK's own output validator raises this prefix (see toolErrorCode).
		const message = "Output validation error: Invalid structured content for tool umls_search";
		const seam = new McpServer({ name: "test", version: "1.0.0" }) as unknown as {
			createToolError(message: string): { structuredContent?: unknown; isError?: boolean };
		};
		const result = seam.createToolError(message);

		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			success: false,
			error: { code: "OUTPUT_VALIDATION_ERROR", message },
		});
	});

	it("does not clobber a structuredContent the SDK error factory supplied", () => {
		// Stands in for a future SDK whose own createToolError is already
		// contract-shaped: the guard must return that result unchanged.
		class CompliantSdkServer extends McpServer {}
		const supplied = {
			content: [{ type: "text", text: "upstream refused" }],
			structuredContent: {
				success: false,
				error: { code: "UPSTREAM_REFUSED", message: "upstream refused" },
			},
			isError: true,
		};
		Object.defineProperty(CompliantSdkServer.prototype, "createToolError", {
			value: () => supplied,
			writable: true,
			configurable: true,
		});

		const server = new CompliantSdkServer({ name: "test", version: "1.0.0" });
		const seam = server as unknown as {
			createToolError(message: string): typeof supplied;
		};

		expect(seam.createToolError("upstream refused")).toBe(supplied);
	});

	it("leaves a contract-compliant result untouched", async () => {
		const body = await callTool({ string: "diabetes" });

		expect(body.result?.isError).toBeFalsy();
		expect(body.result?.structuredContent).toEqual({
			success: true,
			data: { string: "diabetes" },
		});
	});
});

/**
 * Deep readiness.
 *
 * bio-orchestrator answered HTTP 500 to every MCP request for four weeks while
 * `/health` stayed green, because `/health` returns a static payload and never
 * touches the server factory. `readiness()` runs the same construct-and-init
 * path a real request runs, so a factory that throws is reported as 503 with the
 * real reason.
 */
describe("caller upstream keys", () => {
	const KEY = "0123456789abcdef0123456789abcdef0123";

	/** One request through the real handler; the tool answers with the key it saw. */
	async function keySeenByTool(
		meta: Record<string, unknown>,
		register: "tool" | "registerTool",
	): Promise<string | undefined> {
		let server: McpServer | undefined;
		const handler = createMcpHandler(
			() => {
				server = new McpServer({ name: "test", version: "1.0.0" });
				const answer = async () => ({
					content: [{ type: "text" as const, text: server?.callerUpstreamKey("ncbi") ?? "none" }],
					structuredContent: { key: server?.callerUpstreamKey("ncbi") ?? null },
				});
				if (register === "tool") server.tool("whoami", "Report the key", { q: z.string() }, answer);
				else server.registerTool("whoami", { description: "Report the key", inputSchema: z.object({ q: z.string() }) }, answer);
				return server;
			},
			{ route: "/mcp", legacy: "stateless" },
		);
		const response = await handler(
			modernRequest(
				"tools/call",
				{ name: "whoami", arguments: { q: "x" }, _meta: { ...REQUEST_META, ...meta } },
				{ "mcp-name": "whoami" },
			),
			{},
			executionContext(),
		);
		const body = (await response.json()) as ToolCallBody;
		const text = body.result?.content?.[0]?.text;
		return text === "none" ? undefined : text;
	}

	it("gives a tool registered with tool() the key from params._meta", async () => {
		expect(await keySeenByTool({ "dev.quentincody.bio/upstreamKeys": { ncbi: KEY } }, "tool")).toBe(KEY);
	});

	it("gives a tool registered with registerTool() the key from params._meta", async () => {
		expect(await keySeenByTool({ "dev.quentincody.bio/upstreamKeys": { ncbi: KEY } }, "registerTool")).toBe(KEY);
	});

	it("gives no key when the call carries none or a malformed one", async () => {
		expect(await keySeenByTool({}, "tool")).toBeUndefined();
		expect(await keySeenByTool({ "dev.quentincody.bio/upstreamKeys": { ncbi: "bad key" } }, "registerTool")).toBeUndefined();
	});

	it("has no key before any tool call", () => {
		expect(new McpServer({ name: "test", version: "1.0.0" }).callerUpstreamKey("ncbi")).toBeUndefined();
	});
});

describe("the shared registration helpers", () => {
	it("accepts a complete zod object as a tool input schema", () => {
		const server = new McpServer({ name: "test", version: "1.0.0" });
		server.tool("obj", "Object schema", z.object({ value: z.string() }) as never, async () => ({ content: [] }));
		expect(server.toolInputSchemaJson("obj")).toMatchObject({ type: "object", required: ["value"] });
	});

	it("refuses a tool or a prompt with no handler", () => {
		const server = new McpServer({ name: "test", version: "1.0.0" });
		const loose = server as unknown as { tool(...a: unknown[]): unknown; prompt(...a: unknown[]): unknown };
		expect(() => loose.tool("bad", "No handler")).toThrow("Tool bad is missing a handler");
		expect(() => loose.prompt("bad", "No handler")).toThrow("Prompt bad is missing a handler");
	});

	it("registers prompts with and without arguments", () => {
		const server = new McpServer({ name: "test", version: "1.0.0" });
		const message = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
		expect(server.prompt("plain", "No arguments", () => message("hi"))).toBeDefined();
		expect(server.prompt("withArgs", "One argument", { topic: z.string() }, ({ topic }) => message(topic))).toBeDefined();
	});

	it("fails at construction when the SDK no longer has createToolError", () => {
		class FutureSdkServer extends McpServer {}
		Object.defineProperty(FutureSdkServer.prototype, "createToolError", { value: undefined, writable: true, configurable: true });
		expect(() => new FutureSdkServer({ name: "test", version: "1.0.0" })).toThrow("no longer exposes createToolError");
	});
});

describe("StatelessMcpWorker.serve", () => {
	class Echo extends StatelessMcpWorker<unknown> {
		server = new McpServer({ name: "echo", version: "1.0.0" });
		init() {
			this.server.tool("echo", "Echo a value", { value: z.string() }, async ({ value }) => ({
				content: [{ type: "text", text: value }],
				structuredContent: { success: true, data: { value } },
			}));
		}
	}

	it("builds a fresh worker for the request and answers the tool call", async () => {
		const response = await Echo.serve().fetch(
			modernRequest("tools/call", { name: "echo", arguments: { value: "hi" } }, { "mcp-name": "echo" }),
			{},
			executionContext(),
		);
		const body = (await response.json()) as ToolCallBody;
		expect(body.result?.content?.[0]?.text).toBe("hi");
		expect(body.result?.isError).not.toBe(true);
	});
});

describe("StatelessMcpWorker.readiness", () => {
	class Ok extends StatelessMcpWorker<unknown> {
		server = { _registeredTools: { a: {}, mcp_a: {} } } as never;
		init() {}
	}

	class Throws extends StatelessMcpWorker<unknown> {
		server = {} as never;
		init() {
			// The verbatim SDK error that took bio-orchestrator down.
			throw new Error("Tool mcp_execute_bio_code is already registered");
		}
	}

	class NoTools extends StatelessMcpWorker<unknown> {
		server = { _registeredTools: {} } as never;
		init() {}
	}

	it("reports ready with a tool count when the server builds", async () => {
		const res = await Ok.readiness({}, "demo");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ready).toBe(true);
		expect(body.tools).toBe(2);
		expect(body.server).toBe("demo");
	});

	it("reports 503 with the real error when the factory throws", async () => {
		const res = await Throws.readiness({}, "demo");
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ready).toBe(false);
		// The opaque -32603 the client used to get is exactly what this replaces.
		expect(String(body.error)).toContain("already registered");
	});

	it("treats zero registered tools as an outage, not a state", async () => {
		const res = await NoTools.readiness({}, "demo");
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ready).toBe(false);
		expect(String(body.error)).toContain("0 tools");
	});

	it("never throws out of the probe itself", async () => {
		class Weird extends StatelessMcpWorker<unknown> {
			server = null as never;
			init() {}
		}
		const res = await Weird.readiness({}, "demo");
		// A probe that throws would take a healthy server red; it must answer.
		expect(res.status).toBe(503);
	});
});
