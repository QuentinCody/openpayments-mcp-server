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

/**
 * The SDK manufactures a tool result of its own in exactly one place: the
 * `catch` around `validateToolInput()` / `executeToolHandler()` /
 * `validateToolOutput()` in its `tools/call` handler funnels every failure
 * through `createToolError()`, which emits `content` + `isError: true` and no
 * `structuredContent`. That breaks the fleet contract (CLAUDE.md: every tool
 * result, success AND error, carries both fields) for any call the SDK rejects
 * before our handler runs — a client that sends a wrong argument name gets a
 * contract-violating result from a server whose own handlers are compliant.
 *
 * These prefixes are the two messages the SDK's own validators raise, so the
 * envelope can carry a specific code without ever rewriting the message.
 */
const INPUT_VALIDATION_PREFIX = "Input validation error:";
const OUTPUT_VALIDATION_PREFIX = "Output validation error:";

function toolErrorCode(message: string): string {
	if (message.startsWith(INPUT_VALIDATION_PREFIX)) {
		return "INPUT_VALIDATION_ERROR";
	}
	if (message.startsWith(OUTPUT_VALIDATION_PREFIX)) {
		return "OUTPUT_VALIDATION_ERROR";
	}
	return "TOOL_EXECUTION_ERROR";
}

/**
 * `createToolError` is `private` in the SDK's `.d.mts`, so it cannot be
 * overridden by declaration; it is a plain prototype method at runtime and is
 * installed as an own property instead. If the SDK ever renames it the
 * constructor throws rather than reopening the hole silently.
 */
interface ToolErrorFactory {
	createToolError(message: string): CallToolResult;
}

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
		this.enforceToolErrorContract();
	}

	/**
	 * Closes the contract hole at the SDK boundary: a tool error the SDK builds
	 * itself gains the missing `structuredContent`. The SDK's message is kept
	 * verbatim in both fields and `isError` stays true — an error never becomes a
	 * success, and a result that already carries `structuredContent` is returned
	 * untouched.
	 */
	private enforceToolErrorContract(): void {
		const self = this as unknown as ToolErrorFactory;
		const sdkCreateToolError = self.createToolError;
		if (typeof sdkCreateToolError !== "function") {
			throw new TypeError(
				"@modelcontextprotocol/server no longer exposes createToolError; the tool-error contract guard needs a new seam",
			);
		}
		self.createToolError = (message: string): CallToolResult => {
			const result = sdkCreateToolError.call(self, message);
			if (result.structuredContent !== undefined) {
				return result;
			}
			return {
				...result,
				structuredContent: {
					success: false,
					error: { code: toolErrorCode(message), message },
				},
			};
		};
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
		// Deliberately the prototype's registerTool, not `this.registerTool`: a
		// server that monkey-patches the instance method (bio-orchestrator's dual
		// registration) would otherwise see this delegation as a second, nested
		// registration and expand every alias twice.
		return SdkMcpServer.prototype.registerTool.call(
			this,
			name,
			{ description, inputSchema } as never,
			handler as never,
		) as RegisteredTool;
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
