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
 * Optionally also a SECOND, REST upstream (`restApiFetch`) — api.get/api.post
 * routed through the same host proxy + DO-SQLite staging (hybrid GraphQL+REST).
 *
 * API keys never enter the isolate — all HTTP goes through the host's gqlFetch.
 */

import { z } from "zod";
import type { SourceDescriptor } from "../provenance/provenance";
import { getRequestScope, type MaybeExtra } from "../registry/request-scope";
import type { ToolContext } from "../registry/types";
import {
	createApiProxyTool,
	createQueryProxyTool,
	createStageProxyTool,
} from "../tools/api-proxy";
import { createFsProxyHandlers } from "../tools/fs-proxy";
import { createGraphqlProxyTool } from "../tools/graphql-proxy";
import { buildRestApiOverrideSource } from "./api-proxy";
import type { ApiFetchFn } from "./catalog";
import { DynamicWorkerExecutor, type ExecutorFns, type WorkerLoaderBinding } from "./execute-tool";
import { buildFsProxySource } from "./fs-proxy";
import { buildGraphqlExecuteDescription } from "./graphql-execute-description";
import { handleExecutorResult } from "./graphql-execute-result";
import {
	fetchIntrospection,
	type GraphqlFetchFn,
	type TrimmedIntrospection,
} from "./graphql-introspection";
import { buildGraphqlProxySource } from "./graphql-proxy";
import { registerGraphqlSearchTool } from "./graphql-schema-discovery";
import { buildGraphqlSchemaSource } from "./graphql-schema-source";
import { introspectionToSummary } from "./graphql-to-typescript";
import { createCodeModeError, ErrorCodes } from "./response";
import { registerVerifyCitationOnce } from "./verify-citation-tool";

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
	/** WorkspaceDO namespace (ADR-006 Phase 0). When provided AND the `_execute`
	 *  call passes a `workspace` id, auto-staging routes into the shared
	 *  WorkspaceDO (`idFromName("ws:" + workspace)`) so datasets from different
	 *  servers land in one SQLite and can be JOINed. Omit for per-server staging. */
	workspaceNamespace?: unknown;
	/** Canonical upstream source identity. When declared, every result carries a
	 *  verifiable `_meta.citation` (source + query/result hashes + timestamp) so a
	 *  connected agent can attribute and re-verify each claim. Opt-in per server. */
	source?: SourceDescriptor;
	/** Optional SECOND upstream — a REST `ApiFetchFn` (e.g. the RCSB Search API).
	 *  When set, this becomes a hybrid GraphQL+REST Code Mode server: the isolate's
	 *  `api.get`/`api.post` are wired to it and routed through the same host
	 *  `__api_proxy` + DO-SQLite auto-staging as `gql.query`. Document the REST
	 *  surface with `preamble` `//` lines (they appear in the tool description as
	 *  SERVER NOTES). See docs/adding-mcp-servers.md "Hybrid GraphQL + REST". */
	restApiFetch?: ApiFetchFn;
	/** Optional static ApiCatalog. When the upstream disables introspection,
	 *  `<prefix>_search` searches this instead of returning the unavailable note. */
	catalog?: import("./catalog").ApiCatalog;
}

export interface GraphqlExecuteToolResult {
	name: string;
	description: string;
	schema: { code: z.ZodString; workspace?: z.ZodOptional<z.ZodString> };
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
		throw new Error(
			"createGraphqlExecuteTool requires a valid Worker Loader binding",
		);
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

interface WrapCodeOptions {
	schemaSource: string;
	gqlProxySource: string;
	/** REST capability override (api.get/api.post). Empty string when the server
	 *  wired no `restApiFetch` — a pure-GraphQL isolate. Injected AFTER the gql
	 *  proxy so it can reassign the stubs and reuse __wrapStaged. */
	restProxySource: string;
	userCode: string;
	preamble: string | undefined;
	includeFsProxy: boolean;
}

function wrapUserCode(opts: WrapCodeOptions): string {
	const fsProxy = opts.includeFsProxy ? buildFsProxySource() : "";

	return `async () => {
${opts.schemaSource}
${opts.gqlProxySource}
${opts.restProxySource}
${fsProxy}
${opts.preamble ? `\n// --- Preamble (domain helpers) ---\n${opts.preamble}\n// --- End preamble ---\n` : ""}
// --- User code (nested scope so a user const gql/schema/api shadows, not collides — T4.2; see codemode/user-scope.ts) ---
return await (async () => {\n${opts.userCode}\n})();
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
	restProxySource: string;
	buildExecutorFns: (
		sessionId: string | undefined,
		workspace?: string,
	) => ExecutorFns;
	cache: {
		introspection: TrimmedIntrospection | undefined;
		schemaSource: string | undefined;
		description: string | undefined;
		/** Set once when the upstream disables introspection (e.g. NCI PDC's Apollo
		 *  `introspection: false`) so we don't re-fetch every call and the proxy
		 *  skips pre-flight (getIntrospection stays undefined → passthrough). */
		introspectionUnavailable?: boolean;
	};
}

/** Build the isolate's schema-helper source. Real schema when introspection
 *  succeeded; an empty one flagged `available:false` when the upstream disables
 *  introspection (so schema.* exists but reports unavailable). */
function schemaSourceFor(
	introspection: TrimmedIntrospection | undefined,
): string {
	if (introspection) {
		return buildGraphqlSchemaSource(JSON.stringify(introspection));
	}
	return buildGraphqlSchemaSource(
		JSON.stringify({ queryType: { name: "Query" }, types: [] }),
		{
			available: false,
			note: "This API disables GraphQL introspection — schema.* discovery is unavailable; write queries directly with gql.query() using field names from its published schema docs.",
		},
	);
}

/** Build the `_execute` tool description — real schema summary, or an
 *  introspection-unavailable note. */
function describeFor(
	ctx: ExecutionContext,
	introspection: TrimmedIntrospection | undefined,
): string {
	const summary = introspection
		? introspectionToSummary(introspection)
		: "NOTE: this API disables GraphQL introspection — schema.* discovery is unavailable; use gql.query() with field names from its published schema docs.";
	return buildGraphqlExecuteDescription(
		{ ...ctx.options, hasRestApi: !!ctx.options.restApiFetch },
		summary,
	);
}

/** Ensure introspection is fetched and schema source is built.
 *
 * If the upstream disables introspection (e.g. NCI PDC's Apollo server), the
 * fetch throws — degrade to raw passthrough: gql.query() still runs, pre-flight
 * is skipped (introspection stays undefined so the proxy's getIntrospection
 * returns undefined), and schema.* reports unavailable. Flagged so we don't
 * re-attempt the fetch on every call. */
async function ensureIntrospection(ctx: ExecutionContext): Promise<void> {
	if (!ctx.cache.introspection && !ctx.cache.introspectionUnavailable) {
		try {
			ctx.cache.introspection = await fetchIntrospection(ctx.gqlFetch);
		} catch {
			ctx.cache.introspectionUnavailable = true;
		}
	}
	if (!ctx.cache.schemaSource) {
		ctx.cache.schemaSource = schemaSourceFor(ctx.cache.introspection);
	}
	if (!ctx.cache.description) {
		ctx.cache.description = describeFor(ctx, ctx.cache.introspection);
	}
}

/** Execute user code in a V8 isolate with GraphQL + schema helpers. */
async function executeCode(
	ctx: ExecutionContext,
	code: string,
	sessionId: string | undefined,
	workspace?: string,
) {
	await ensureIntrospection(ctx);

	const wrappedCode = wrapUserCode({
		schemaSource: ctx.cache.schemaSource!,
		gqlProxySource: ctx.gqlProxySource,
		restProxySource: ctx.restProxySource,
		userCode: code,
		preamble: ctx.preamble,
		includeFsProxy: ctx.includeFsProxy,
	});
	const executor = new DynamicWorkerExecutor({
		loader: ctx.loader,
		timeout: ctx.timeout,
	});
	const result = await executor.execute(
		wrappedCode,
		ctx.buildExecutorFns(sessionId, workspace),
	);
	return await handleExecutorResult(result, {
		source: ctx.options.source,
		server: ctx.options.prefix,
		tool: `${ctx.options.prefix}_execute`,
		query: code,
	});
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createExecutorFnsBuilder(
	graphqlProxyTool: ReturnType<typeof createGraphqlProxyTool>,
	doNamespace: unknown,
	prefix: string,
	fsDoNamespace: unknown,
	workspaceNamespace?: unknown,
	apiProxyTool?: ReturnType<typeof createApiProxyTool>,
): (sessionId: string | undefined, workspace?: string) => ExecutorFns {
	const queryProxyTool = doNamespace
		? createQueryProxyTool({ doNamespace, workspaceNamespace })
		: undefined;
	const stageProxyTool = doNamespace
		? createStageProxyTool({
				doNamespace,
				stagingPrefix: prefix,
				workspaceNamespace,
			})
		: undefined;
	const fsHandlers: ExecutorFns = fsDoNamespace
		? createFsProxyHandlers({
				doNamespace: fsDoNamespace as Parameters<
					typeof createFsProxyHandlers
				>[0]["doNamespace"],
			})
		: {};

	return (sessionId: string | undefined, workspace?: string) => {
		const ctx: ToolContext = { sql: () => [], sessionId, workspace };
		return {
			__graphql_proxy: async (args: unknown) =>
				graphqlProxyTool.handler(toInput(args), ctx),
			__query_proxy: async (args: unknown) => {
				if (!queryProxyTool) {
					return {
						__query_error: true,
						message:
							"Staged data querying is not available (no DO namespace configured)",
					};
				}
				return queryProxyTool.handler(toInput(args), ctx);
			},
			__stage_proxy: async (args: unknown) => {
				if (!stageProxyTool) {
					return {
						__stage_error: true,
						message:
							"Data staging is not available (no DO namespace configured)",
					};
				}
				return stageProxyTool.handler(toInput(args), ctx);
			},
			// Hybrid GraphQL+REST: when a second REST upstream is wired, the isolate's
			// reassigned api.get/api.post route here (same DO-SQLite auto-staging).
			...(apiProxyTool
				? {
						__api_proxy: async (args: unknown) =>
							apiProxyTool.handler(toInput(args), ctx),
					}
				: {}),
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
	const {
		prefix,
		gqlFetch,
		doNamespace,
		loader: rawLoader,
		stagingThreshold,
		timeout = 30_000,
		preamble,
		fsDoNamespace,
		workspaceNamespace,
		restApiFetch,
	} = options;

	const loader = validateLoader(rawLoader);
	const toolName = `${prefix}_execute`;

	// Shared mutable cache — `ensureIntrospection` (run before user code) fills
	// `cache.introspection`, and the proxy reads it via getIntrospection for the
	// T1.2 pre-flight. Declared first so both the proxy and ctx close over it.
	const cache: ExecutionContext["cache"] = {
		introspection: options.introspection,
		schemaSource: undefined,
		description: undefined,
	};

	const graphqlProxyTool = createGraphqlProxyTool({
		gqlFetch,
		doNamespace,
		stagingPrefix: prefix,
		stagingThreshold,
		workspaceNamespace,
		getIntrospection: () => cache.introspection,
	});
	// Hybrid GraphQL+REST: a second REST upstream gets its own __api_proxy host
	// handler, sharing the same DO namespace + stagingPrefix so Search results
	// stage into the same SQLite as gql.query and are queryable by `_query_data`.
	const apiProxyTool = restApiFetch
		? createApiProxyTool({
				apiFetch: restApiFetch,
				doNamespace,
				stagingPrefix: prefix,
				stagingThreshold,
				workspaceNamespace,
			})
		: undefined;
	const buildExecutorFns = createExecutorFnsBuilder(
		graphqlProxyTool,
		doNamespace,
		prefix,
		fsDoNamespace,
		workspaceNamespace,
		apiProxyTool,
	);

	const ctx: ExecutionContext = {
		gqlFetch,
		options,
		loader,
		timeout,
		preamble,
		includeFsProxy: !!fsDoNamespace,
		gqlProxySource: buildGraphqlProxySource(),
		restProxySource: restApiFetch ? buildRestApiOverrideSource() : "",
		buildExecutorFns,
		cache,
	};

	// T2.2 — when introspection is available at registration (pre-cached/eager),
	// the description carries the REAL schema summary (query roots, types, args)
	// instead of the "use schema.queryRoot()" placeholder, so the author sees the
	// shape at tools/list without a discovery round-trip.
	const initialDescription = buildGraphqlExecuteDescription(
		{ ...options, hasRestApi: !!restApiFetch },
		cache.introspection
			? introspectionToSummary(cache.introspection)
			: "Use schema.queryRoot() to discover available query fields.",
	);

	return {
		name: toolName,
		description: initialDescription,
		schema: {
			code: z
				.string()
				.describe(
					"JavaScript code to execute. Use gql.query() for GraphQL queries and schema.* for discovery. " +
						"The last expression or explicit return value becomes the result. " +
						"Example: const r = await gql.query('{ target(q: { sym: \"EGFR\" }) { name tdl } }'); return r;",
				),
			workspace: z
				.string()
				.optional()
				.describe(
					"Shared workspace id — stage into a cross-server workspace DO so other servers' datasets can be JOINed in one query. Omit for per-server staging.",
				),
		},

		register(server: { tool: (...args: unknown[]) => void }) {
			server.tool(
				toolName,
				this.description,
				this.schema,
				async (input: { code: string; workspace?: string }, extra: unknown) => {
					const code = input.code?.trim();
					if (!code) {
						return createCodeModeError(
							ErrorCodes.INVALID_ARGUMENTS,
							"code is required",
						);
					}
					try {
						const scope = getRequestScope(extra as MaybeExtra | undefined);
						return await executeCode(ctx, code, scope, input.workspace);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return createCodeModeError(
							ErrorCodes.UNKNOWN_ERROR,
							`${prefix}_execute failed: ${message}`,
						);
					}
				},
			);
			// Sibling discovery tool (#3): shares the lazy introspection cache.
			registerGraphqlSearchTool(server, {
				prefix,
				apiName: options.apiName ?? prefix,
				gqlFetch,
				cache,
				catalog: options.catalog,
			});

			// Sibling provenance tool: results carry `_meta.citation` integrity
			// anchors, so the server must also expose the means to re-check them.
			registerVerifyCitationOnce(server);
		},
	};
}
