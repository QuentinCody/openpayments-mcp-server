import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serializedBytes } from "../agentic/lossless";
import { canonicalJson, sha256Hex } from "../provenance/provenance";
import type { ToolContext, ToolEntry } from "./types";

const MCP_STRUCTURED_LIMIT_BYTES = 100_000;
const RESULT_CHUNK_CHARS = 16_000;

function toolNames(name: string): [string, string] {
	const canonical = name.startsWith("mcp_") ? name.slice(4) : name;
	return [`mcp_${canonical}`, canonical];
}

async function storeLosslessToolResult(
	ctx: ToolContext,
	toolName: string,
	result: unknown,
): Promise<Record<string, unknown>> {
	const canonical = canonicalJson(result);
	const resultId = `result_${crypto.randomUUID()}`;
	const payloadHash = `sha256:${await sha256Hex(canonical)}`;
	ctx.sql`
		CREATE TABLE IF NOT EXISTS __lossless_tool_result_chunks (
			result_id TEXT NOT NULL,
			chunk_index INTEGER NOT NULL,
			chunk_text TEXT NOT NULL,
			PRIMARY KEY (result_id, chunk_index)
		)
	`;
	let chunkCount = 0;
	for (let offset = 0; offset < canonical.length; offset += RESULT_CHUNK_CHARS) {
		const chunk = canonical.slice(offset, offset + RESULT_CHUNK_CHARS);
		ctx.sql`
			INSERT INTO __lossless_tool_result_chunks (result_id, chunk_index, chunk_text)
			VALUES (${resultId}, ${chunkCount}, ${chunk})
		`;
		chunkCount++;
	}
	return {
		lossless: true,
		storage: "orchestrator_sqlite",
		result_id: resultId,
		tool: toolName,
		payload_hash: payloadHash,
		payload_bytes: serializedBytes(result),
		chunk_count: chunkCount,
		chunk_table: "__lossless_tool_result_chunks",
		retrieval_sql:
			`SELECT chunk_index, chunk_text FROM __lossless_tool_result_chunks ` +
			`WHERE result_id = '${resultId.replace(/'/g, "''")}' ORDER BY chunk_index`,
		complete: true,
	};
}

async function toolSuccess(
	ctx: ToolContext,
	toolName: string,
	result: unknown,
): Promise<Record<string, unknown>> {
	const structured = {
		success: true as const,
		...(result === undefined ? {} : { data: result }),
	};
	if (serializedBytes(structured) <= MCP_STRUCTURED_LIMIT_BYTES) {
		return {
			content: [
				{
					type: "text",
					text: result === undefined ? "undefined" : JSON.stringify(result),
				},
			],
			structuredContent: structured,
		};
	}
	const reference = await storeLosslessToolResult(ctx, toolName, result);
	return {
		content: [{ type: "text", text: JSON.stringify(reference) }],
		structuredContent: { success: true, data: reference },
	};
}

/**
 * Tool definition shape for type generation (avoids hard dep on @cloudflare/codemode).
 */
export type ToolDefinition = {
	name: string;
	description?: string;
	inputSchema: unknown;
};

/**
 * Unified tool registry — the single place tools are defined.
 *
 * Derives MCP registration, isolate call routing, executor function maps,
 * and type generation from the same ToolEntry definitions.
 */
export class ToolRegistry {
	private tools: ToolEntry[] = [];
	private toolByName = new Map<string, ToolEntry>();
	private ctx: ToolContext;

	constructor(ctx: ToolContext) {
		this.ctx = ctx;
	}

	/**
	 * Add tool entries to the registry.
	 */
	add(...entries: ToolEntry[]): void {
		this.tools.push(...entries);
		for (const entry of entries) {
			this.toolByName.set(entry.name, entry);
		}
	}

	/**
	 * Register all tools with the MCP server.
	 * Wraps each handler to produce MCP-formatted responses.
	 * Hidden tools are skipped — they're only callable from V8 isolates.
	 */
	registerAll(server: McpServer): void {
		for (const tool of this.tools) {
			if (tool.hidden) continue;
			const ctx = this.ctx;
			for (const registeredName of toolNames(tool.name)) {
				server.tool(registeredName, tool.description, tool.schema, async (input) => {
					try {
						const result = await tool.handler(input, ctx);
						return await toolSuccess(ctx, tool.name, result) as never;
					} catch (e: unknown) {
						const error = e instanceof Error ? e.message : String(e);
						return {
							isError: true,
							content: [{ type: "text", text: JSON.stringify({ error }) }],
							structuredContent: {
								success: false,
								error: { code: "TOOL_EXECUTION_ERROR", message: error },
							},
						};
					}
				});
			}
		}
	}

	/**
	 * Handle a tool call from a V8 isolate (via CodeModeProxy → DO RPC).
	 */
	async handleIsolateCall(
		functionName: string,
		args: unknown[],
	): Promise<unknown> {
		const tool = this.toolByName.get(functionName);
		if (!tool) {
			return { error: `Unknown tool: ${functionName}` };
		}
		const input = (args[0] ?? {}) as Record<string, unknown>;
		return tool.handler(input, this.ctx);
	}

	/**
	 * Build a function map of ALL tools (including hidden) for the DynamicWorkerExecutor.
	 * Each function takes a single args object and returns the handler result.
	 */
	buildExecutorFns(
		ctx: ToolContext,
	): Record<string, (args: unknown) => Promise<unknown>> {
		const fns: Record<string, (args: unknown) => Promise<unknown>> = {};
		for (const tool of this.tools) {
			const t = tool;
			fns[t.name] = async (args: unknown) => {
				const input = (args ?? {}) as Record<string, unknown>;
				return t.handler(input, ctx);
			};
		}
		return fns;
	}

	/**
	 * Convert non-hidden tools to ToolDescriptors for generateTypes().
	 * Wraps the shape Record<string, ZodType> into z.object() since
	 * generateTypes expects inputSchema to be a ZodType.
	 */
	toToolDescriptors(): Record<
		string,
		{ description: string; inputSchema: z.ZodType }
	> {
		const descriptors: Record<
			string,
			{ description: string; inputSchema: z.ZodType }
		> = {};
		for (const tool of this.tools) {
			if (tool.hidden) continue;
			descriptors[tool.name] = {
				description: tool.description,
				inputSchema: z.object(tool.schema),
			};
		}
		return descriptors;
	}

	/**
	 * Get tool definitions for type generation.
	 * Returns the shape expected by generateTypes().
	 * Hidden tools are excluded — they get separate type declarations.
	 */
	getDefinitions(): ToolDefinition[] {
		return this.tools
			.filter((t) => !t.hidden)
			.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.schema,
			}));
	}
}
