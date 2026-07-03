/**
 * `defineTool()` — the typed, contract-safe way to register a hand-built MCP tool.
 *
 * Track E of the agent-readiness plan: move the fleet's 7 semantic tool
 * invariants from prose (CLAUDE.md "Key Patterns & Conventions") into the type
 * system so they become *impossible to violate at compile time* instead of
 * runtime surprises a reviewer has to catch.
 *
 * A single call:
 *   defineTool(server, { name, description, inputSchema, source?, handler })
 *
 * enforces / applies, automatically:
 *   1. **Both fields, both branches.** The handler's return type is a
 *      discriminated union ({@link ToolResult}) whose success branch REQUIRES
 *      `content` + `structuredContent`, and whose error branch REQUIRES
 *      `content` + `structuredContent` + `isError: true`. Omitting
 *      `structuredContent` (or `isError` on the error path) is a `tsc` error —
 *      not a silent 500.
 *   2. **Dual registration.** Registers under BOTH `mcp_<server>_<tool>` and
 *      `<server>_<tool>` from the single `name` you pass.
 *   3. **100KB transport guard.** MCP Streamable-HTTP silently drops responses
 *      over 100KB; the wrapper size-checks `structuredContent` and drops the
 *      heavy `data` payload (keeping `_meta` + citation) before it can be lost.
 *   4. **Verifiable provenance.** When a `source` descriptor is given, every
 *      successful result carries a `_meta.citation` (source + query/result
 *      hashes + timestamp) via the shared provenance helper.
 *
 * The `structuredContent` shape mirrors the fleet's existing Code Mode envelope
 * (`{ success, data, _meta }` / `{ success:false, error }`) so results are a
 * drop-in for the cf/ chat's Sources panel and every existing consumer.
 *
 * This module is additive: it does not change any server. Servers opt in by
 * importing `{ defineTool }` from `@bio-mcp/shared`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
	CallToolResult,
	ServerNotification,
	ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type {
	ErrorResponse,
	ResponseMeta,
	SuccessResponse,
} from "../codemode/response";
import { buildCitation, type SourceDescriptor } from "../provenance/provenance";

/** MCP Streamable-HTTP silently drops responses larger than this. */
const MAX_STRUCTURED_CONTENT_BYTES = 100_000;

/** A single text content block — the fleet's human/agent-readable summary. */
export interface ToolContent {
	type: "text";
	text: string;
}

/**
 * The context object every tool handler receives as its second argument,
 * identical to what `server.registerTool`'s callback is handed (session id,
 * request metadata, abort signal, …). On Cloudflare McpAgent it additionally
 * carries `env`; read it with a cast (`(extra as { env?: Env }).env`).
 */
export type ToolHandlerExtra = RequestHandlerExtra<
	ServerRequest,
	ServerNotification
>;

/**
 * Success branch of a tool's return. REQUIRES `content` + `structuredContent`.
 * `isError` is optionally `false` so this stays distinct from {@link ToolErr}.
 */
export interface ToolOk<Data = unknown> {
	content: ToolContent[];
	structuredContent: SuccessResponse<Data>;
	isError?: false;
}

/**
 * Error branch of a tool's return. REQUIRES `content` + `structuredContent` +
 * `isError: true`. Because the inner body is `{ success: false, ... }`, an
 * error object can never masquerade as a {@link ToolOk} — forgetting
 * `isError: true` is *also* a compile error.
 */
export interface ToolErr {
	content: ToolContent[];
	structuredContent: ErrorResponse;
	isError: true;
}

/**
 * The discriminated union a `defineTool` handler must return. Neither branch
 * lets you omit `structuredContent`; the error branch pins `isError: true`.
 * This is the compile-time gate — the whole point of the factory.
 */
export type ToolResult<Data = unknown> = ToolOk<Data> | ToolErr;

/** Infer the parsed argument object from a raw Zod shape. */
type InferShape<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

/** The typed handler a caller supplies to {@link defineTool}. */
export type ToolHandler<Shape extends z.ZodRawShape, Data> = (
	args: InferShape<Shape>,
	extra: ToolHandlerExtra,
) => ToolResult<Data> | Promise<ToolResult<Data>>;

/** Configuration for {@link defineTool}. */
export interface DefineToolConfig<Shape extends z.ZodRawShape, Data = unknown> {
	/**
	 * Canonical `<server>_<tool>` tool name (e.g. `"gnomad_gene_constraint"`).
	 * The factory also registers the `mcp_`-prefixed alias automatically.
	 */
	name: string;
	/** Human/agent-facing description shown in `tools/list`. */
	description: string;
	/** Optional display title. */
	title?: string;
	/** Raw Zod shape for the tool's arguments — drives typed `args`. */
	inputSchema: Shape;
	/**
	 * Upstream source descriptor. When present, every SUCCESSFUL result gets a
	 * verifiable `_meta.citation` (source + query/result hashes + timestamp).
	 */
	source?: SourceDescriptor;
	/** Optional MCP tool annotations. */
	annotations?: Record<string, unknown>;
	/** The typed handler. Its return type enforces the tool contract. */
	handler: ToolHandler<Shape, Data>;
}

/** Options for {@link toolOk}. */
export interface ToolOkOptions {
	/** Override the text-content summary (default: truncated JSON preview). */
	text?: string;
	/** `_meta` to attach (citation is added automatically when a source is set). */
	meta?: ResponseMeta;
	/** Max characters for the auto-generated JSON preview (default 300). */
	maxPreviewChars?: number;
}

/** Options for {@link toolErr}. */
export interface ToolErrOptions {
	/** Override the text-content summary (default: `Error: <message>`). */
	text?: string;
	/** Structured error details. */
	details?: unknown;
}

function previewJson(value: unknown, maxChars: number): string {
	const json = JSON.stringify(value, null, 2);
	if (json === undefined) return "undefined";
	return json.length <= maxChars
		? json
		: `${json.slice(0, maxChars)}\n... [truncated for display]`;
}

/**
 * Build a contract-valid SUCCESS result. Guarantees `content` +
 * `structuredContent: { success: true, data, _meta? }`.
 */
export function toolOk<Data>(
	data: Data,
	options: ToolOkOptions = {},
): ToolOk<Data> {
	const { text, meta, maxPreviewChars = 300 } = options;
	const structuredContent: SuccessResponse<Data> = {
		success: true,
		data,
		...(meta && Object.keys(meta).length > 0 ? { _meta: meta } : {}),
	};
	return {
		content: [
			{ type: "text", text: text ?? previewJson(structuredContent, maxPreviewChars) },
		],
		structuredContent,
	};
}

/**
 * Build a contract-valid ERROR result. Guarantees `content` +
 * `structuredContent: { success: false, error }` + `isError: true`.
 */
export function toolErr(
	code: string,
	message: string,
	options: ToolErrOptions = {},
): ToolErr {
	const structuredContent: ErrorResponse = {
		success: false,
		error: {
			code,
			message,
			...(options.details !== undefined ? { details: options.details } : {}),
		},
	};
	return {
		content: [{ type: "text", text: options.text ?? `Error: ${message}` }],
		structuredContent,
		isError: true,
	};
}

function resolveRecordCount(
	data: unknown,
	meta: ResponseMeta | undefined,
): number | undefined {
	if (Array.isArray(data)) return data.length;
	if (meta && typeof meta.row_count === "number") return meta.row_count;
	return undefined;
}

function resolveDataAccessId(
	data: unknown,
	meta: ResponseMeta | undefined,
): string | undefined {
	if (meta && typeof meta.data_access_id === "string") return meta.data_access_id;
	if (
		data &&
		typeof data === "object" &&
		typeof (data as Record<string, unknown>).data_access_id === "string"
	) {
		return (data as Record<string, unknown>).data_access_id as string;
	}
	return undefined;
}

/**
 * The minimal surface of `McpServer` we call. Declared structurally so the
 * SDK's zod-v4 generic machinery on `registerTool` can't fight our strict,
 * caller-facing handler type (the compile-time gate lives on
 * {@link DefineToolConfig.handler}, not here).
 */
type ToolRegistrar = (
	name: string,
	config: {
		title?: string;
		description?: string;
		inputSchema?: unknown;
		annotations?: unknown;
	},
	cb: (args: unknown, extra: unknown) => unknown,
) => unknown;

/**
 * Register a hand-built MCP tool with the full fleet contract enforced by the
 * type system and applied automatically. See the module header for details.
 *
 * @param server the `McpServer` to register on
 * @param config typed tool definition — `handler`'s return type is the gate
 */
export function defineTool<Shape extends z.ZodRawShape, Data = unknown>(
	server: McpServer,
	config: DefineToolConfig<Shape, Data>,
): void {
	// Derive both registration names from the single canonical name.
	const bare = config.name.startsWith("mcp_")
		? config.name.slice("mcp_".length)
		: config.name;
	const prefixed = `mcp_${bare}`;

	const wrapped = async (
		args: InferShape<Shape>,
		extra: ToolHandlerExtra,
	): Promise<CallToolResult> => {
		let result: ToolResult<Data>;
		try {
			result = await config.handler(args, extra);
		} catch (err) {
			// Safety net: a thrown handler still yields a contract-valid error.
			const message = err instanceof Error ? err.message : String(err);
			result = toolErr("UNHANDLED_ERROR", `${bare} failed: ${message}`);
		}

		const isError = result.isError === true;
		const structured: Record<string, unknown> = { ...result.structuredContent };

		// (4) Verifiable provenance — success results only, when a source is set.
		if (!isError && config.source && structured.success === true) {
			const data = structured.data;
			const meta = structured._meta as ResponseMeta | undefined;
			const citation = await buildCitation({
				source: config.source,
				server: config.source.id,
				tool: bare,
				query: args,
				result: data,
				retrievedAt: new Date().toISOString(),
				recordCount: resolveRecordCount(data, meta),
				dataAccessId: resolveDataAccessId(data, meta),
			});
			structured._meta = { ...(meta ?? {}), citation };
		}

		// (3) 100KB Streamable-HTTP transport guard.
		if (JSON.stringify(structured).length > MAX_STRUCTURED_CONTENT_BYTES) {
			if (structured.success === true) {
				const meta = (structured._meta as ResponseMeta | undefined) ?? {};
				structured.data = undefined;
				structured._meta = {
					...meta,
					truncated: true,
					truncated_reason:
						"structuredContent exceeded the 100KB MCP Streamable-HTTP limit; `data` omitted to avoid a silent drop. Stage/query the dataset or narrow the request. The citation's result_hash still attests the full result.",
				};
			} else if (structured.error && typeof structured.error === "object") {
				structured.error = {
					...(structured.error as Record<string, unknown>),
					details: undefined,
				};
			}
		}

		return {
			content: result.content,
			structuredContent: structured,
			...(isError ? { isError: true } : {}),
		} as CallToolResult;
	};

	// (2) Dual registration — bind() preserves `this`; the loose cast is the
	// single, localized SDK-boundary escape hatch.
	const register = server.registerTool.bind(server) as unknown as ToolRegistrar;
	const toolConfig = {
		title: config.title,
		description: config.description,
		inputSchema: config.inputSchema,
		...(config.annotations ? { annotations: config.annotations } : {}),
	};
	register(prefixed, toolConfig, wrapped as (a: unknown, e: unknown) => unknown);
	register(bare, toolConfig, wrapped as (a: unknown, e: unknown) => unknown);
}
