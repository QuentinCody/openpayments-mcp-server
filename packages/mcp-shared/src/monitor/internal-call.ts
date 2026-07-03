/**
 * Monitoring primitive — in-fabric tool call.
 *
 * Re-runs a monitored {server, tool, params} query by calling the target
 * server's MyMCP Durable Object directly over the agents-SDK RPC method
 * (`handleMcpMessage`), NOT over its public /mcp endpoint. A cross-script DO
 * stub bypasses the Worker's public route entirely, so the unauthenticated
 * public surface is never touched and no MCP handshake is needed.
 *
 * Returns the tool's raw `structuredContent` (or parsed text content); each
 * source module's profile handles its own response envelope (e.g. Code Mode
 * execute wraps the payload under `data` with volatile `_meta`).
 */

/** Minimal shape of a target server's MyMCP DO stub (agents SDK RPC). */
export interface McpRpcStub {
	handleMcpMessage(message: unknown): Promise<McpRpcResponse | undefined>;
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
		params: { name: tool, arguments: params },
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

/** Call a tool on a target server's MyMCP DO stub and return its structuredContent. */
export async function callTool(
	stub: McpRpcStub,
	tool: string,
	params: Record<string, unknown>,
	id: number,
): Promise<unknown> {
	const resp = await stub.handleMcpMessage(buildToolCall(tool, params, id));
	return parseToolResult(resp);
}
