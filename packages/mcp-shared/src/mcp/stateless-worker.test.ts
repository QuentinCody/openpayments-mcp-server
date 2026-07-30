import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpHandler, McpServer } from "./stateless-worker";

const REQUEST_META = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientInfo": {
		name: "shared-adapter-test",
		version: "1.0.0",
	},
	"io.modelcontextprotocol/clientCapabilities": {},
};

function modernRequest(method: string, params: Record<string, unknown> = {}) {
	return new Request("https://example.test/mcp", {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-method": method,
			"mcp-protocol-version": "2026-07-28",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method,
			params: { _meta: REQUEST_META, ...params },
		}),
	});
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
});
