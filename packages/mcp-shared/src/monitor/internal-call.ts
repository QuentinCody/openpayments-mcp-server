/**
 * Monitoring primitive — in-fabric tool call.
 *
 * Re-runs a monitored {server, tool, params} query over a Cloudflare service
 * binding. The request stays in-fabric but travels through the target Worker's
 * stateless MCP 2026-07-28 handler, including the required per-request envelope
 * and standard MCP headers.
 *
 * Returns the tool's raw `structuredContent` (or parsed text content); each
 * source module's profile handles its own response envelope (e.g. Code Mode
 * execute wraps the payload under `data` with volatile `_meta`).
 */

/** Minimal service-binding shape needed by the monitor. */
export interface McpServiceFetcher {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The JSON-RPC response shape we read from a tools/call. */
export interface McpRpcResponse {
	result?: {
		structuredContent?: unknown;
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
	};
	error?: { code: number; message: string };
}

/** Build a JSON-RPC `tools/call` message for one tool invocation. */
export function buildToolCall(
	tool: string,
	params: Record<string, unknown>,
	id: number,
) {
	return {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: {
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientInfo": {
					name: "bio-mcp-monitor",
					version: "1.0.0",
				},
				"io.modelcontextprotocol/clientCapabilities": {},
			},
			name: tool,
			arguments: params,
		},
	};
}

/**
 * Extract the structuredContent (or parsed text content) from a tools/call
 * response. Throws on a transport error, a missing result, or a tool-level
 * error, so the caller never hashes an error envelope as if it were data.
 */
export function parseToolResult(resp: McpRpcResponse | undefined): unknown {
	if (!resp)
		throw new Error("monitor in-fabric call: empty response (notification?)");
	if (resp.error)
		throw new Error(`monitor in-fabric call failed: ${resp.error.message}`);
	const result = resp.result;
	if (!result) throw new Error("monitor in-fabric call: missing result");
	if (result.isError) {
		throw new Error(
			`monitored tool returned an error: ${result.content?.[0]?.text ?? "tool error"}`,
		);
	}
	if (result.structuredContent !== undefined) return result.structuredContent;
	const text = result.content?.[0]?.text;
	if (typeof text === "string") {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	throw new Error(
		"monitor in-fabric call: no structuredContent or text content",
	);
}

/** Call a tool through an in-fabric Worker service binding. */
export async function callTool(
	service: McpServiceFetcher,
	tool: string,
	params: Record<string, unknown>,
	id: number,
): Promise<unknown> {
	const response = await service.fetch("https://mcp.internal/mcp", {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": tool,
			"mcp-protocol-version": "2026-07-28",
		},
		body: JSON.stringify(buildToolCall(tool, params, id)),
	});
	const resp = (await response.json()) as McpRpcResponse;
	return parseToolResult(resp);
}
