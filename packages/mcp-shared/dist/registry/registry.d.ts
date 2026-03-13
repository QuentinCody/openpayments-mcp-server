import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolEntry, ToolContext } from "./types";
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
export declare class ToolRegistry {
    private tools;
    private toolByName;
    private ctx;
    constructor(ctx: ToolContext);
    /**
     * Add tool entries to the registry.
     */
    add(...entries: ToolEntry[]): void;
    /**
     * Register all tools with the MCP server.
     * Wraps each handler to produce MCP-formatted responses.
     * Hidden tools are skipped — they're only callable from V8 isolates.
     */
    registerAll(server: McpServer): void;
    /**
     * Handle a tool call from a V8 isolate (via CodeModeProxy → DO RPC).
     */
    handleIsolateCall(functionName: string, args: unknown[]): Promise<unknown>;
    /**
     * Build a function map of ALL tools (including hidden) for the DynamicWorkerExecutor.
     * Each function takes a single args object and returns the handler result.
     */
    buildExecutorFns(ctx: ToolContext): Record<string, (args: unknown) => Promise<unknown>>;
    /**
     * Convert non-hidden tools to ToolDescriptors for generateTypes().
     * Wraps the shape Record<string, ZodType> into z.object() since
     * generateTypes expects inputSchema to be a ZodType.
     */
    toToolDescriptors(): Record<string, {
        description: string;
        inputSchema: z.ZodType;
    }>;
    /**
     * Get tool definitions for type generation.
     * Returns the shape expected by generateTypes().
     * Hidden tools are excluded — they get separate type declarations.
     */
    getDefinitions(): ToolDefinition[];
}
//# sourceMappingURL=registry.d.ts.map