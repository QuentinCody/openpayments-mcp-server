import type { McpServer } from "../mcp/stateless-worker";
import { z } from "zod";
import { serializedBytes } from "../agentic/lossless";
import { shouldStage } from "../staging/utils";
import { getRequestCorrelation, type MaybeExtra } from "./request-scope";
import type { ToolContext, ToolEntry } from "./types";

export interface RegistryToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent: Record<string, unknown>;
	isError?: boolean;
	[key: string]: unknown;
}

/** Transport-specific citation and staging, applied to both success and failure. */
export type ToolResponseFinalizer = (
	result: RegistryToolResult,
	toolName: string,
	input: Record<string, unknown>,
	extra: unknown,
) => Promise<RegistryToolResult>;

function toolError(message: string, code = "TOOL_EXECUTION_ERROR"): RegistryToolResult {
	return {
		isError: true,
		content: [{ type: "text", text: JSON.stringify({ error: message }) }],
		structuredContent: { success: false, error: { code, message } },
	};
}

function toolNames(name: string): [string, string] {
	const canonical = name.startsWith("mcp_") ? name.slice(4) : name;
	return [`mcp_${canonical}`, canonical];
}

function toolSuccess(result: unknown): RegistryToolResult {
	const structured = {
		success: true as const,
		...(result === undefined ? {} : { data: result }),
	};
	return {
		content: [{ type: "text", text: result === undefined ? "undefined" : JSON.stringify(result) }],
		structuredContent: structured,
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

	constructor(ctx: ToolContext, private readonly finalizeResponse?: ToolResponseFinalizer) {
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
				server.tool(
					registeredName,
					tool.description,
					tool.schema,
					async (input, extra) => {
						let response: RegistryToolResult;
						try {
							const requestContext = getRequestCorrelation(extra as MaybeExtra);
							const callContext = requestContext
								? { ...ctx, requestContext }
								: ctx;
							const result = await tool.handler(input, callContext);
							response = toolSuccess(result);
						} catch (e: unknown) {
							const error = e instanceof Error ? e.message : String(e);
							response = toolError(error);
						}
						try {
							if (this.finalizeResponse) response = await this.finalizeResponse(response, tool.name, input, extra);
							// Reserve room for SDK transport metadata. Never return an oversized
							// result, even when no storage was configured or a finalizer failed.
							if (shouldStage(serializedBytes(response) + 1024)) {
								return toolError("The complete response requires staging storage.", "RESPONSE_TOO_LARGE") as never;
							}
							return response as never;
						} catch {
							return toolError("The complete tool response could not be returned.", "RESPONSE_ERROR") as never;
						}
					},
				);
			}
		}
	}

	/**
	 * Handle a tool call from a V8 isolate through a caller-supplied proxy.
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
