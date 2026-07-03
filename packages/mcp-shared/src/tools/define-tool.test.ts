import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	defineTool,
	type ToolHandler,
	type ToolResult,
	toolErr,
	toolOk,
} from "./define-tool";

// ---------------------------------------------------------------------------
// Compile-time gate — the whole point of the factory. A `defineTool` handler
// must return `ToolResult`, so proving these violations are `tsc` errors proves
// the contract is impossible to violate. If any @ts-expect-error STOPS erroring,
// `pnpm --filter @bio-mcp/shared type-check` fails on an unused directive
// (TS2578) — a loud regression signal.
// ---------------------------------------------------------------------------

// @ts-expect-error — success result REQUIRES structuredContent
const badOkMissingStructured: ToolResult<{ a: number }> = {
	content: [{ type: "text", text: "x" }],
};

// @ts-expect-error — error result REQUIRES structuredContent
const badErrMissingStructured: ToolResult = {
	content: [{ type: "text", text: "x" }],
	isError: true,
};

// @ts-expect-error — error result REQUIRES isError: true
const badErrMissingIsError: ToolResult = {
	content: [{ type: "text", text: "x" }],
	structuredContent: { success: false, error: { code: "E", message: "m" } },
};

// Positive controls — these MUST compile.
const goodOk: ToolResult<{ n: number }> = toolOk({ n: 1 });
const goodErr: ToolResult = toolErr("E", "m");
const goodManual: ToolResult<{ y: string }> = {
	content: [{ type: "text", text: "ok" }],
	structuredContent: { success: true, data: { y: "z" } },
};
// Handler args are inferred from inputSchema (args.gene is a string here).
const typedArgs: ToolHandler<{ gene: z.ZodString }, { len: number }> = (args) =>
	toolOk({ len: args.gene.length });

// Keep the type-only bindings from tripping noUnusedVariables.
void [
	badOkMissingStructured,
	badErrMissingStructured,
	badErrMissingIsError,
	goodOk,
	goodErr,
	goodManual,
	typedArgs,
];

interface CapturedCall {
	name: string;
	config: { description?: string; inputSchema?: unknown };
	cb: (
		args: unknown,
		extra: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		structuredContent: Record<string, unknown>;
		isError?: boolean;
	}>;
}

function fakeServer() {
	const calls: CapturedCall[] = [];
	const server = {
		registerTool(
			name: string,
			config: CapturedCall["config"],
			cb: CapturedCall["cb"],
		) {
			calls.push({ name, config, cb });
			return { name };
		},
	} as unknown as McpServer;
	return { server, calls };
}

describe("defineTool", () => {
	it("dual-registers both mcp_<name> and <name>", () => {
		const { server, calls } = fakeServer();
		defineTool(server, {
			name: "demo_echo",
			description: "d",
			inputSchema: { gene: z.string() },
			handler: (args) => toolOk({ echoed: args.gene }),
		});
		expect(calls.map((c) => c.name).sort()).toEqual([
			"demo_echo",
			"mcp_demo_echo",
		]);
	});

	it("derives the bare name when given an mcp_-prefixed name", () => {
		const { server, calls } = fakeServer();
		defineTool(server, {
			name: "mcp_demo_echo",
			description: "d",
			inputSchema: {},
			handler: () => toolOk({ ok: true }),
		});
		expect(calls.map((c) => c.name).sort()).toEqual([
			"demo_echo",
			"mcp_demo_echo",
		]);
	});

	it("success path carries content + structuredContent + a verifiable citation", async () => {
		const { server, calls } = fakeServer();
		defineTool(server, {
			name: "demo_echo",
			description: "d",
			inputSchema: { gene: z.string() },
			source: { id: "demo", name: "Demo Source", license: "CC0" },
			handler: (args) => toolOk({ echoed: args.gene }),
		});
		const res = await calls[0].cb({ gene: "TP53" }, {});
		expect(res.isError).toBeUndefined();
		expect(res.content[0].text).toBeTruthy();
		const sc = res.structuredContent as {
			success: boolean;
			data: unknown;
			_meta: {
				citation: { result_hash: string; tool: string; server: string };
			};
		};
		expect(sc.success).toBe(true);
		expect(sc.data).toEqual({ echoed: "TP53" });
		expect(sc._meta.citation.result_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(sc._meta.citation.tool).toBe("demo_echo");
		expect(sc._meta.citation.server).toBe("demo");
	});

	it("omits the citation when no source descriptor is declared", async () => {
		const { server, calls } = fakeServer();
		defineTool(server, {
			name: "demo_echo",
			description: "d",
			inputSchema: { gene: z.string() },
			handler: (args) => toolOk({ echoed: args.gene }),
		});
		const res = await calls[0].cb({ gene: "TP53" }, {});
		const sc = res.structuredContent as { _meta?: unknown };
		expect(sc._meta).toBeUndefined();
	});

	it("error path returns both fields + isError: true and no citation", async () => {
		const { server, calls } = fakeServer();
		defineTool(server, {
			name: "demo_fail",
			description: "d",
			inputSchema: {},
			source: { id: "demo", name: "Demo Source" },
			handler: () => toolErr("NOPE", "bad input"),
		});
		const res = await calls[0].cb({}, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("bad input");
		const sc = res.structuredContent as {
			success: boolean;
			error: { code: string; message: string };
			_meta?: unknown;
		};
		expect(sc.success).toBe(false);
		expect(sc.error.code).toBe("NOPE");
		expect(sc._meta).toBeUndefined();
	});

	it("converts a thrown handler into a contract-valid error", async () => {
		const { server, calls } = fakeServer();
		defineTool(server, {
			name: "demo_throw",
			description: "d",
			inputSchema: {},
			handler: () => {
				throw new Error("boom");
			},
		});
		const res = await calls[0].cb({}, {});
		expect(res.isError).toBe(true);
		const sc = res.structuredContent as {
			success: boolean;
			error: { code: string; message: string };
		};
		expect(sc.success).toBe(false);
		expect(sc.error.message).toContain("boom");
	});

	it("drops oversized structuredContent data past the 100KB limit but keeps the citation", async () => {
		const { server, calls } = fakeServer();
		defineTool(server, {
			name: "demo_big",
			description: "d",
			inputSchema: {},
			source: { id: "demo", name: "Demo Source" },
			handler: () =>
				toolOk({
					rows: Array.from({ length: 20000 }, (_, i) => ({
						i,
						s: "xxxxxxxxxxxxxxxxxxxx",
					})),
				}),
		});
		const res = await calls[0].cb({}, {});
		const sc = res.structuredContent as {
			success: boolean;
			data: unknown;
			_meta: { truncated?: boolean; citation?: { result_hash: string } };
		};
		expect(sc.success).toBe(true);
		expect(sc.data).toBeUndefined();
		expect(sc._meta.truncated).toBe(true);
		expect(sc._meta.citation?.result_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(res.structuredContent).length).toBeLessThan(100_000);
	});
});
