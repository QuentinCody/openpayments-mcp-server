import { describe, expect, it } from "vitest";
import { buildToolCall, callTool, parseToolResult } from "./internal-call";

describe("buildToolCall", () => {
	it("builds a JSON-RPC tools/call message", () => {
		expect(buildToolCall("orange_book_execute", { code: "x" }, 7)).toMatchObject({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
				name: "orange_book_execute",
				arguments: { code: "x" },
			},
		});
	});
});

describe("parseToolResult", () => {
	it("returns structuredContent when present", () => {
		expect(
			parseToolResult({ result: { structuredContent: { a: 1 } } }),
		).toEqual({ a: 1 });
	});
	it("parses content[0].text JSON when there is no structuredContent", () => {
		expect(
			parseToolResult({
				result: { content: [{ type: "text", text: '{"b":2}' }] },
			}),
		).toEqual({ b: 2 });
	});
	it("returns the raw text when content is non-JSON", () => {
		expect(
			parseToolResult({
				result: { content: [{ type: "text", text: "hello" }] },
			}),
		).toBe("hello");
	});
	it("throws on an empty (notification) response", () => {
		expect(() => parseToolResult(undefined)).toThrow(/empty response/);
	});
	it("throws on a JSON-RPC error", () => {
		expect(() =>
			parseToolResult({ error: { code: -32000, message: "boom" } }),
		).toThrow(/boom/);
	});
	it("throws when result is missing", () => {
		expect(() => parseToolResult({})).toThrow(/missing result/);
	});
	it("throws when the tool itself errored (isError), surfacing the text", () => {
		expect(() =>
			parseToolResult({
				result: { isError: true, content: [{ type: "text", text: "bad NDA" }] },
			}),
		).toThrow(/bad NDA/);
	});
	it("throws on isError with no content text", () => {
		expect(() => parseToolResult({ result: { isError: true } })).toThrow(
			/tool error/,
		);
	});
	it("throws when there is neither structuredContent nor text", () => {
		expect(() =>
			parseToolResult({ result: { content: [{ type: "image" }] } }),
		).toThrow(/no structuredContent/);
	});
});

describe("callTool", () => {
	it("sends a modern request over the service binding", async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const service = {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ input, init });
				return Response.json({
					jsonrpc: "2.0",
					id: 3,
					result: { structuredContent: { ok: true } },
				});
			},
		};
		const out = await callTool(service, "t", { p: 1 }, 3);
		expect(out).toEqual({ ok: true });
		expect(calls[0].input).toBe("https://mcp.internal/mcp");
		expect(calls[0].init?.headers).toMatchObject({
			"mcp-method": "tools/call",
			"mcp-name": "t",
			"mcp-protocol-version": "2026-07-28",
		});
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
			method: "tools/call",
			params: { name: "t", arguments: { p: 1 } },
		});
	});
});
