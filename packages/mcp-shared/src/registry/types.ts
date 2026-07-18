import type { z } from "zod";

/**
 * SQL tagged template function type used throughout the platform.
 */
export type SqlTaggedTemplate = <
	T = Record<string, string | number | boolean | null>,
>(
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
	 * Raw Cloudflare `SqlStorage` for the agent's own DO (hardening doc 02 §3).
	 * Optional and only wired by servers that expose the write tools: it lets
	 * `sql_exec` read the exact `databaseSize` (O(1)) for the DO-size ceiling
	 * and a cursor's `rowsWritten` for the per-statement rows cap — neither of
	 * which the tagged-template `sql` above can see. When absent, the write
	 * guard falls back to `PRAGMA page_count` x `page_size` and skips the rows
	 * cap.
	 */
	sqlStorage?: SqlStorage;
	/**
	 * Application-scope identifier for the current request — the key used
	 * to bookkeep staged datasets in the `__registry__` DO so
	 * `<prefix>_get_schema` (without a data_access_id) can enumerate
	 * everything the same caller staged earlier in the conversation.
	 *
	 * Historically populated from the MCP transport sessionId; the
	 * execute tools now resolve it via `getRequestScope(extra)`, which
	 * prefers `_meta["dev.quentincody.bio/chatId"]` and the `mcp-chat-id` header before
	 * falling back to the transport session. The field name is kept
	 * for back-compat with all downstream proxy tools (api-proxy,
	 * stage-proxy, graphql-proxy, sparql-proxy) that already read
	 * `ctx.sessionId` and forward it to `stageToDoAndRespond`.
	 */
	sessionId?: string;
	/**
	 * ADR-006 Phase 0 — shared workspace id for the current request. When set
	 * (and the server wired a `workspaceNamespace`), Code Mode auto-staging routes
	 * into the shared WorkspaceDO (`idFromName("ws:" + workspace)`) so datasets
	 * from different servers land in one SQLite and can be JOINed. Absent = today's
	 * per-server staging, unchanged. Flows in from the `_execute` `workspace` arg.
	 */
	workspace?: string;
}

/**
 * Single source of truth for a tool definition.
 * MCP registration, isolate routing, and type generation all derive from this.
 */
export interface ToolEntry {
	name: string;
	description: string;
	schema: Record<string, z.ZodType>;
	handler: (
		input: Record<string, unknown>,
		ctx: ToolContext,
	) => Promise<unknown>;
	/** If true, tool is callable from V8 isolates but not exposed via MCP tools/list or type generation. */
	hidden?: boolean;
}
