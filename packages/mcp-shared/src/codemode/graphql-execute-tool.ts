/**
 * GraphQL execute tool factory — creates a `<prefix>_execute` tool for
 * GraphQL Code Mode.
 *
 * Uses DynamicWorkerExecutor to run user code in a sandboxed V8 isolate.
 * The isolate gets:
 * - gql.query(queryString, variables?) — GraphQL execution through host
 * - schema.types(), schema.type(), schema.search() etc. — introspection helpers
 * - db.stage(), db.queryStaged(), api.query() — staging helpers
 * - console.log() capture
 *
 * API keys never enter the isolate — all HTTP goes through the host's gqlFetch.
 */

import { z } from "zod";
import {
	DynamicWorkerExecutor,
	type WorkerLoaderBinding,
	type ExecutorFns,
} from "./execute-tool";
import {
	fetchIntrospection,
	type GraphqlFetchFn,
	type TrimmedIntrospection,
} from "./graphql-introspection";
import { buildGraphqlSchemaSource } from "./graphql-schema-source";
import { buildGraphqlProxySource } from "./graphql-proxy";
import { introspectionToSummary } from "./graphql-to-typescript";
import { createGraphqlProxyTool } from "../tools/graphql-proxy";
import { createQueryProxyTool, createStageProxyTool } from "../tools/api-proxy";
import { createFsProxyHandlers } from "../tools/fs-proxy";
import { buildFsProxySource } from "./fs-proxy";
import type { ToolContext } from "../registry/types";
import { createCodeModeResponse, createCodeModeError, ErrorCodes } from "./response";

// ---------------------------------------------------------------------------
// Options & result types
// ---------------------------------------------------------------------------

export interface GraphqlExecuteToolOptions {
	/** Tool name prefix (e.g., "pharos" → "pharos_execute") */
	prefix: string;
	/** Function to execute GraphQL queries on the host */
	gqlFetch: GraphqlFetchFn;
	/** DO namespace for auto-staging large responses */
	doNamespace?: unknown;
	/** Worker Loader binding for V8 isolate creation */
	loader: unknown;
	/** Byte threshold for auto-staging (default 30KB) */
	stagingThreshold?: number;
	/** Execution timeout in ms (default 30000) */
	timeout?: number;
	/** Optional JavaScript source injected before user code (domain-specific helpers/quirks) */
	preamble?: string;
	/** DO namespace for virtual filesystem (optional) */
	fsDoNamespace?: unknown;
	/** Pre-cached introspection result. If omitted, fetched lazily on first execute. */
	introspection?: TrimmedIntrospection;
	/** Display name for the API in tool description */
	apiName?: string;
}

export interface GraphqlExecuteToolResult {
	name: string;
	description: string;
	schema: { code: z.ZodString };
	register: (server: { tool: (...args: unknown[]) => void }) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateLoader(rawLoader: unknown): WorkerLoaderBinding {
	if (
		!rawLoader ||
		typeof rawLoader !== "object" ||
		!("get" in rawLoader) ||
		typeof (rawLoader as WorkerLoaderBinding).get !== "function"
	) {
		throw new Error("createGraphqlExecuteTool requires a valid Worker Loader binding");
	}
	return rawLoader as WorkerLoaderBinding;
}

/** Coerce executor args to Record<string, unknown>. */
function toInput(args: unknown): Record<string, unknown> {
	if (args !== null && typeof args === "object" && !Array.isArray(args)) {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(args)) {
			result[k] = v;
		}
		return result;
	}
	return {};
}

function buildDescription(
	options: GraphqlExecuteToolOptions,
	apiSummary: string,
): string {
	const { prefix, preamble, fsDoNamespace } = options;
	const name = options.apiName ?? prefix;

	return (
		`Execute JavaScript code against the ${name} GraphQL API. ` +
		`Code runs in a sandboxed V8 isolate with:\n` +
		`- gql.query(queryString, variables?) — execute GraphQL queries (returns data directly, e.g. result.gene not result.data.gene)\n` +
		`- schema.types(), schema.type(name), schema.search(query) — explore the schema\n` +
		`- schema.queryRoot() — list available query entry points with args\n` +
		`- schema.enumValues(name), schema.inputType(name) — inspect enums and input types\n` +
		`- console logging (log, warn, error, info) — captured output\n` +
		(fsDoNamespace
			? `- fs.readFile(path), fs.writeFile(path, content), fs.readJSON(path), fs.writeJSON(path, data) — persistent virtual filesystem\n` +
				`- fs.readdir(path), fs.mkdir(path), fs.stat(path), fs.exists(path), fs.rm(path), fs.glob(pattern) — directory operations\n`
			: "") +
		(preamble ? `\nDomain-specific helper functions and quirks are documented below.\n` : "") +
		`\nThe last expression or return value is the result.\n` +
		(apiSummary ? `\n${apiSummary}\n\n` : "\n") +
		`STAGING: Large responses (>30KB) are auto-staged into SQLite. When this happens, ` +
		`gql.query returns {__staged: true, data_access_id, schema, tables_created, total_rows, message}. ` +
		`Scalar properties from the original response are preserved on the staged object.\n\n` +
		`When staging occurs:\n` +
		`1. Check result.__staged === true\n` +
		`2. Read any preserved scalars (result.count, result.total, etc.)\n` +
		`3. Return the staging metadata — the caller will use ${prefix}_query_data with the data_access_id to explore the data with SQL\n\n` +
		`DO NOT try to access .results, .data, .entries, .items on a staged response — those arrays were replaced by SQLite tables.\n\n` +
		`For advanced use: api.query(data_access_id, sql) and db.queryStaged(data_access_id, sql) are available to query staged data ` +
		`within the same execution (returns {results, row_count}, max 1000 rows, SELECT only).\n\n` +
		`SCRATCHPAD: db.stage(data, tableName?) stages any array/object into SQLite and returns {data_access_id, tables_created, total_rows}. ` +
		`Use this to persist computed or filtered results for SQL queries.\n\n` +
		`IMPORTANT: Use pagination params (first/after, limit/offset) to keep responses small. If you need large datasets, let them auto-stage and return the staging info.` +
		(preamble ? `\n\nSERVER NOTES:\n${extractPreambleNotes(preamble)}` : "")
	);
}

/** Extract comment lines from a preamble to include in tool description. */
function extractPreambleNotes(preamble: string): string {
	return preamble
		.split("\n")
		.filter((line) => line.trim().startsWith("//"))
		.map((line) => line.trim().replace(/^\/\/\s?/, ""))
		.join("\n");
}

interface WrapCodeOptions {
	schemaSource: string;
	gqlProxySource: string;
	userCode: string;
	preamble: string | undefined;
	includeFsProxy: boolean;
}

function wrapUserCode(opts: WrapCodeOptions): string {
	const fsProxy = opts.includeFsProxy ? buildFsProxySource() : "";

	return `async () => {
${opts.schemaSource}
${opts.gqlProxySource}
${fsProxy}
${opts.preamble ? `\n// --- Preamble (domain helpers) ---\n${opts.preamble}\n// --- End preamble ---\n` : ""}
// --- User code ---
${opts.userCode}
// --- End user code ---
}`;
}

// ---------------------------------------------------------------------------
// Execution context — holds mutable cache + immutable config for the handler
// ---------------------------------------------------------------------------

interface ExecutionContext {
	gqlFetch: GraphqlFetchFn;
	options: GraphqlExecuteToolOptions;
	loader: WorkerLoaderBinding;
	timeout: number;
	preamble: string | undefined;
	includeFsProxy: boolean;
	gqlProxySource: string;
	buildExecutorFns: (sessionId: string | undefined) => ExecutorFns;
	cache: {
		introspection: TrimmedIntrospection | undefined;
		schemaSource: string | undefined;
		description: string | undefined;
	};
}

/** Ensure introspection is fetched and schema source is built. */
async function ensureIntrospection(ctx: ExecutionContext): Promise<void> {
	if (!ctx.cache.introspection) {
		ctx.cache.introspection = await fetchIntrospection(ctx.gqlFetch);
	}
	if (!ctx.cache.schemaSource) {
		ctx.cache.schemaSource = buildGraphqlSchemaSource(JSON.stringify(ctx.cache.introspection));
	}
	if (!ctx.cache.description) {
		const summary = introspectionToSummary(ctx.cache.introspection);
		ctx.cache.description = buildDescription(ctx.options, summary);
	}
}

/** Execute user code in a V8 isolate with GraphQL + schema helpers. */
async function executeCode(ctx: ExecutionContext, code: string, sessionId: string | undefined) {
	await ensureIntrospection(ctx);

	const wrappedCode = wrapUserCode({
		schemaSource: ctx.cache.schemaSource!,
		gqlProxySource: ctx.gqlProxySource,
		userCode: code,
		preamble: ctx.preamble,
		includeFsProxy: ctx.includeFsProxy,
	});
	const executor = new DynamicWorkerExecutor({ loader: ctx.loader, timeout: ctx.timeout });
	const result = await executor.execute(wrappedCode, ctx.buildExecutorFns(sessionId));
	return handleExecutorResult(result);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createExecutorFnsBuilder(
	graphqlProxyTool: ReturnType<typeof createGraphqlProxyTool>,
	doNamespace: unknown,
	prefix: string,
	fsDoNamespace: unknown,
): (sessionId: string | undefined) => ExecutorFns {
	const queryProxyTool = doNamespace ? createQueryProxyTool({ doNamespace }) : undefined;
	const stageProxyTool = doNamespace ? createStageProxyTool({ doNamespace, stagingPrefix: prefix }) : undefined;
	const fsHandlers: ExecutorFns = fsDoNamespace
		? createFsProxyHandlers({ doNamespace: fsDoNamespace as Parameters<typeof createFsProxyHandlers>[0]["doNamespace"] })
		: {};

	return (sessionId: string | undefined) => {
		const ctx: ToolContext = { sql: () => [], sessionId };
		return {
			__graphql_proxy: async (args: unknown) => graphqlProxyTool.handler(toInput(args), ctx),
			__query_proxy: async (args: unknown) => {
				if (!queryProxyTool) {
					return { __query_error: true, message: "Staged data querying is not available (no DO namespace configured)" };
				}
				return queryProxyTool.handler(toInput(args), ctx);
			},
			__stage_proxy: async (args: unknown) => {
				if (!stageProxyTool) {
					return { __stage_error: true, message: "Data staging is not available (no DO namespace configured)" };
				}
				return stageProxyTool.handler(toInput(args), ctx);
			},
			...fsHandlers,
		};
	};
}

/**
 * Create a GraphQL execute tool registration object.
 */
export function createGraphqlExecuteTool(
	options: GraphqlExecuteToolOptions,
): GraphqlExecuteToolResult {
	const { prefix, gqlFetch, doNamespace, loader: rawLoader, stagingThreshold, timeout = 30_000, preamble, fsDoNamespace } = options;

	const loader = validateLoader(rawLoader);
	const toolName = `${prefix}_execute`;

	const graphqlProxyTool = createGraphqlProxyTool({ gqlFetch, doNamespace, stagingPrefix: prefix, stagingThreshold });
	const buildExecutorFns = createExecutorFnsBuilder(graphqlProxyTool, doNamespace, prefix, fsDoNamespace);

	const ctx: ExecutionContext = {
		gqlFetch,
		options,
		loader,
		timeout,
		preamble,
		includeFsProxy: !!fsDoNamespace,
		gqlProxySource: buildGraphqlProxySource(),
		buildExecutorFns,
		cache: { introspection: options.introspection, schemaSource: undefined, description: undefined },
	};

	const initialDescription = buildDescription(options, "Use schema.queryRoot() to discover available query fields.");

	return {
		name: toolName,
		description: initialDescription,
		schema: {
			code: z.string().describe(
				"JavaScript code to execute. Use gql.query() for GraphQL queries and schema.* for discovery. " +
				"The last expression or explicit return value becomes the result. " +
				'Example: const r = await gql.query(\'{ target(q: { sym: "EGFR" }) { name tdl } }\'); return r;',
			),
		},

		register(server: { tool: (...args: unknown[]) => void }) {
			server.tool(toolName, this.description, this.schema, async (input: { code: string }, extra: unknown) => {
				const code = input.code?.trim();
				if (!code) {
					return createCodeModeError(ErrorCodes.INVALID_ARGUMENTS, "code is required");
				}
				try {
					const sessionId = (extra as { sessionId?: string } | undefined)?.sessionId;
					return await executeCode(ctx, code, sessionId);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return createCodeModeError(ErrorCodes.UNKNOWN_ERROR, `${prefix}_execute failed: ${message}`);
				}
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Result handling (shared with REST execute-tool pattern)
// ---------------------------------------------------------------------------

function handleExecutorResult(
	result: { result?: unknown; error?: string; logs?: string[]; __stagedResults?: Array<Record<string, unknown>> },
) {
	if (result.error) {
		// Recover staging metadata if the error was from accessing staged arrays
		if (result.__stagedResults?.length) {
			const staged = result.__stagedResults[result.__stagedResults.length - 1];
			const logOutput = result.logs?.length ? result.logs.join("\n") : undefined;
			const { schema: _s, _staging: _st, ...slim } = staged;
			return createCodeModeResponse(slim, {
				meta: {
					staged: true,
					data_access_id: staged.data_access_id as string,
					tables_created: staged.tables_created,
					total_rows: staged.total_rows,
					...(logOutput ? { console_output: logOutput } : {}),
					executed_at: new Date().toISOString(),
				},
			});
		}

		const logOutput = result.logs?.length
			? `\n\nConsole output:\n${result.logs.join("\n")}`
			: "";
		return createCodeModeError(ErrorCodes.API_ERROR, `${result.error}${logOutput}`);
	}

	const logOutput = result.logs?.length ? result.logs.join("\n") : undefined;
	const raw = result.result;

	// Detect staging metadata in the result
	const isStaged = raw !== null && typeof raw === "object" && !Array.isArray(raw)
		&& "__staged" in raw && (raw as { __staged: unknown }).__staged === true;

	let responseData: unknown = raw;
	const stagingMeta: Record<string, unknown> = {};

	if (isStaged) {
		const resultObj: Record<string, unknown> = { ...raw as object };
		stagingMeta.staged = true;
		stagingMeta.data_access_id = resultObj.data_access_id;
		stagingMeta.tables_created = resultObj.tables_created;
		stagingMeta.total_rows = resultObj.total_rows;

		// Strip large fields available via get_schema tool
		const { schema: _s, _staging: _st, ...slim } = resultObj;
		responseData = slim;
	}

	return createCodeModeResponse(responseData, {
		meta: {
			...stagingMeta,
			...(logOutput ? { console_output: logOutput } : {}),
			executed_at: new Date().toISOString(),
		},
	});
}
