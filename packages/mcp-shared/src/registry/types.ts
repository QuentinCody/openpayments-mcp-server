import type { z } from "zod";

/**
 * SQL tagged template function type used throughout the platform.
 */
export type SqlTaggedTemplate = <T = Record<string, string | number | boolean | null>>(
	strings: TemplateStringsArray,
	...values: (string | number | boolean | null)[]
) => T[];

/**
 * Context passed to every tool handler.
 * Provides access to platform primitives without coupling tools to McpAgent.
 */
export interface ToolContext {
	sql: SqlTaggedTemplate;
	/**
	 * MCP session identifier for the current request. Required for the
	 * session-scoped staging registry (`__registry__` DO) so
	 * `<prefix>_get_schema` without a data_access_id can enumerate all
	 * datasets staged in the same session.
	 *
	 * Code Mode proxy tools (api-proxy, stage-proxy, graphql-proxy,
	 * sparql-proxy) read this to thread sessionId into
	 * stageToDoAndRespond()'s 7th parameter.
	 */
	sessionId?: string;
}

/**
 * Single source of truth for a tool definition.
 * MCP registration, isolate routing, and type generation all derive from this.
 */
export interface ToolEntry {
	name: string;
	description: string;
	schema: Record<string, z.ZodType>;
	handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
	/** If true, tool is callable from V8 isolates but not exposed via MCP tools/list or type generation. */
	hidden?: boolean;
}
