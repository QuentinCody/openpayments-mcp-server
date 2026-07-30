import {
	McpServer as SdkMcpServer,
	type CallToolResult,
	type GetPromptResult,
	type Implementation,
	type McpRequestContext,
	type RegisteredPrompt,
	type RegisteredTool,
	type ServerContext,
	type ServerOptions,
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

export { createMcpHandler };
export type { ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";

const STATIC_LIST_TTL_MS = 5 * 60 * 1000;

/**
 * Fleet defaults for the cacheable result types introduced by MCP 2026-07-28.
 * Tool, prompt, resource, and discovery surfaces are static for the lifetime of
 * a deployment. Resource reads remain uncached unless a server opts in with a
 * more specific hint.
 */
const DEFAULT_CACHE_HINTS: NonNullable<ServerOptions["cacheHints"]> = {
	"tools/list": { ttlMs: STATIC_LIST_TTL_MS, cacheScope: "private" },
	"prompts/list": { ttlMs: STATIC_LIST_TTL_MS, cacheScope: "private" },
	"resources/list": { ttlMs: STATIC_LIST_TTL_MS, cacheScope: "private" },
	"resources/templates/list": {
		ttlMs: STATIC_LIST_TTL_MS,
		cacheScope: "private",
	},
	"resources/read": { ttlMs: 0, cacheScope: "private" },
	"server/discover": { ttlMs: STATIC_LIST_TTL_MS, cacheScope: "private" },
};

type ToolResult = CallToolResult | Promise<CallToolResult>;
type PromptResult = GetPromptResult | Promise<GetPromptResult>;
type RawShape = z.ZodRawShape;
type ShapeInput<Shape extends RawShape> = z.infer<z.ZodObject<Shape>>;

function objectSchema(schema: unknown): unknown {
	if (
		schema &&
		typeof schema === "object" &&
		("~standard" in schema || "_def" in schema)
	) {
		return schema;
	}
	return z.object((schema ?? {}) as RawShape);
}

/**
 * MCP SDK v2 server with the fleet cache policy and a narrow compatibility
 * face for the removed v1 `tool()` / `prompt()` conveniences. The compatibility
 * methods immediately translate to v2 `registerTool()` / `registerPrompt()`
 * with Zod object schemas; no legacy protocol implementation is involved.
 */
export class McpServer extends SdkMcpServer {
	constructor(serverInfo: Implementation, options: ServerOptions = {}) {
		super(serverInfo, {
			...options,
			cacheHints: {
				...DEFAULT_CACHE_HINTS,
				...options.cacheHints,
			},
		});
	}

	tool<Shape extends RawShape>(
		name: string,
		description: string,
		inputSchema: Shape,
		handler: (
			args: ShapeInput<Shape>,
			context: ServerContext,
		) => ToolResult,
	): RegisteredTool;
	tool(
		name: string,
		description: string,
		handler: (context: ServerContext) => ToolResult,
	): RegisteredTool;
	tool(name: string, ...parts: unknown[]): RegisteredTool {
		const description = typeof parts[0] === "string" ? parts.shift() : undefined;
		const handler = parts.pop();
		if (typeof handler !== "function") {
			throw new TypeError(`Tool ${name} is missing a handler`);
		}
		const inputSchema = parts.length > 0 ? objectSchema(parts[0]) : undefined;
		return this.registerTool(
			name,
			{ description, inputSchema } as never,
			handler as never,
		);
	}

	prompt<Shape extends RawShape>(
		name: string,
		description: string,
		argsSchema: Shape,
		handler: (
			args: ShapeInput<Shape>,
			context: ServerContext,
		) => PromptResult,
	): RegisteredPrompt;
	prompt(
		name: string,
		description: string,
		handler: (context: ServerContext) => PromptResult,
	): RegisteredPrompt;
	prompt(name: string, ...parts: unknown[]): RegisteredPrompt {
		const description = typeof parts[0] === "string" ? parts.shift() : undefined;
		const handler = parts.pop();
		if (typeof handler !== "function") {
			throw new TypeError(`Prompt ${name} is missing a handler`);
		}
		const argsSchema = parts.length > 0 ? objectSchema(parts[0]) : undefined;
		return this.registerPrompt(
			name,
			{ description, argsSchema } as never,
			handler as never,
		);
	}
}

interface LegacyServeOptions {
	/** Ignored after the stateless migration; retained while call sites converge. */
	binding?: string;
}

interface WorkerHandler {
	fetch(
		request: Request,
		env: unknown,
		ctx: ExecutionContext,
	): Promise<Response>;
}

type WorkerConstructor = new (
	state?: unknown,
	env?: unknown,
) => StatelessMcpWorker<unknown>;

/**
 * Request-scoped Cloudflare Worker adapter for MCP 2026-07-28.
 *
 * It deliberately resembles the small surface exposed by the fleet's former
 * stateful adapter, but it is not a Durable Object and owns no transport session.
 * A fresh v2 McpServer is registered for every request, which gives the SDK the
 * context needed for `server/discover`, envelope validation, deterministic tool
 * order, result stamping, and the stateless legacy fallback.
 */
export abstract class StatelessMcpWorker<Env = unknown> {
	readonly env: Env;
	protected executionContext: ExecutionContext | undefined;
	protected requestContext: McpRequestContext | undefined;

	constructor(_state?: unknown, env?: Env) {
		this.env = env as Env;
	}

	abstract server: SdkMcpServer;
	abstract init(): void | Promise<void>;

	private setRequestContext(
		requestContext: McpRequestContext,
		executionContext: ExecutionContext,
	): void {
		this.requestContext = requestContext;
		this.executionContext = executionContext;
	}

	static serve(
		route = "/mcp",
		_options: LegacyServeOptions = {},
	): WorkerHandler {
		const Worker = this as unknown as WorkerConstructor;
		return {
			async fetch(
				request: Request,
				env: unknown,
				executionContext: ExecutionContext,
			): Promise<Response> {
				const handler = createMcpHandler(
					async (requestContext) => {
						const worker = new Worker(undefined, env);
						worker.setRequestContext(requestContext, executionContext);
						await worker.init();
						return worker.server;
					},
					{
						route,
						legacy: "stateless",
					},
				);
				return handler(request, env, executionContext);
			},
		};
	}
}
