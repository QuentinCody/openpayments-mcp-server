/**
 * SPARQL execute tool factory — creates a `<prefix>_execute` tool for
 * SPARQL Code Mode. Sibling of createGraphqlExecuteTool.
 *
 * The isolate gets:
 *   sparql.query(queryString, opts?) — execute SELECT/CONSTRUCT/DESCRIBE
 *   sparql.ask(queryString)          — execute ASK; returns boolean
 *   sparql.raw(queryString, opts?)   — return unparsed JSON envelope
 *   prefixes                         — common ontology prefix map
 *   prefixHeader                     — pre-built `PREFIX ...` block
 *   db.stage(), db.queryStaged(), api.query() — staging helpers
 *
 * The endpoint URL never enters the isolate — all HTTP goes through the
 * host's sparqlFetch via codemode.__sparql_proxy.
 */

import { z } from "zod";
import {
	DynamicWorkerExecutor,
	type WorkerLoaderBinding,
	type ExecutorFns,
} from "./execute-tool";
import { buildSparqlProxySource } from "./sparql-proxy";
import {
	COMMON_PREFIXES,
	buildPrefixHeader,
	probeSparqlEndpoint,
	type SparqlEndpointDescription,
	type SparqlFetchFn,
} from "./sparql-introspection";
import { createSparqlProxyTool } from "../tools/sparql-proxy";
import { createQueryProxyTool, createStageProxyTool } from "../tools/api-proxy";
import { createFsProxyHandlers } from "../tools/fs-proxy";
import { buildFsProxySource } from "./fs-proxy";
import type { ToolContext } from "../registry/types";
import { createCodeModeResponse, createCodeModeError, ErrorCodes } from "./response";

export interface SparqlExecuteToolOptions {
	/** Tool name prefix (e.g., "bgee" → "bgee_execute") */
	prefix: string;
	/** Function to execute SPARQL queries on the host */
	sparqlFetch: SparqlFetchFn;
	/** Endpoint URL (used in tool description only — does NOT enter isolate) */
	endpointUrl: string;
	/** DO namespace for auto-staging large responses */
	doNamespace?: unknown;
	/** Worker Loader binding for V8 isolate creation */
	loader: unknown;
	/** Byte threshold for auto-staging (default 30KB) */
	stagingThreshold?: number;
	/** Execution timeout in ms (default 30000) */
	timeout?: number;
	/** Optional JS source injected before user code (domain-specific notes/quirks) */
	preamble?: string;
	/** DO namespace for virtual filesystem (optional) */
	fsDoNamespace?: unknown;
	/** Pre-cached endpoint description. If omitted, probed lazily on first execute. */
	description?: SparqlEndpointDescription;
	/** Display name in tool description (default = prefix) */
	apiName?: string;
	/** Custom prefix map to inject into isolate (defaults to COMMON_PREFIXES) */
	prefixes?: Record<string, string>;
}

export interface SparqlExecuteToolResult {
	name: string;
	description: string;
	schema: { code: z.ZodString };
	/**
	 * Register the tool on the MCP server. When `probeEagerly` is true (default),
	 * this awaits a one-shot endpoint probe before calling `server.tool(...)` so
	 * that `tools/list` returns the real endpoint shape in the description
	 * instead of the "not yet probed" fallback.
	 */
	register: (
		server: { tool: (...args: unknown[]) => void },
		opts?: { probeEagerly?: boolean },
	) => Promise<void>;
}

function validateLoader(rawLoader: unknown): WorkerLoaderBinding {
	if (
		!rawLoader ||
		typeof rawLoader !== "object" ||
		!("get" in rawLoader) ||
		typeof (rawLoader as WorkerLoaderBinding).get !== "function"
	) {
		throw new Error("createSparqlExecuteTool requires a valid Worker Loader binding");
	}
	return rawLoader as WorkerLoaderBinding;
}

function toInput(args: unknown): Record<string, unknown> {
	if (args !== null && typeof args === "object" && !Array.isArray(args)) {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(args)) result[k] = v;
		return result;
	}
	return {};
}

function buildEndpointSummary(d: SparqlEndpointDescription | undefined): string {
	if (!d) {
		return "Endpoint shape not yet probed. Start with small SELECT/ASK queries and add LIMIT early.";
	}
	const parts: string[] = [];
	if (d.graphs.length > 0) parts.push(`Named graphs (${d.graphs.length}): ${d.graphs.slice(0, 8).join(", ")}${d.graphs.length > 8 ? ", ..." : ""}`);
	if (d.predicates.length > 0) parts.push(`Sample predicates: ${d.predicates.slice(0, 12).join(", ")}${d.predicates.length > 12 ? ", ..." : ""}`);
	if (d.classes.length > 0) parts.push(`Sample classes (rdf:type values): ${d.classes.slice(0, 8).join(", ")}${d.classes.length > 8 ? ", ..." : ""}`);
	if (d.warnings.length > 0) parts.push(`Probe warnings: ${d.warnings.join("; ")}`);
	return parts.join("\n");
}

function extractPreambleNotes(preamble: string): string {
	return preamble
		.split("\n")
		.filter((line) => line.trim().startsWith("//"))
		.map((line) => line.trim().replace(/^\/\/\s?/, ""))
		.join("\n");
}

function buildDescription(
	options: SparqlExecuteToolOptions,
	endpointSummary: string,
): string {
	const { prefix, preamble, fsDoNamespace, endpointUrl } = options;
	const name = options.apiName ?? prefix;

	return (
		`Execute JavaScript code against the ${name} SPARQL endpoint (${endpointUrl}). ` +
		`Code runs in a sandboxed V8 isolate with:\n` +
		`- sparql.query(queryString, opts?) — run SELECT/CONSTRUCT/DESCRIBE; returns array of plain { variable: value } rows\n` +
		`- sparql.ask(queryString) — run ASK; returns boolean\n` +
		`- sparql.raw(queryString, opts?) — return unparsed { head, results } envelope\n` +
		`- prefixes — object of common ontology prefixes (rdfs, owl, xsd, skos, dcterms, void, obo, uberon, go, ncbigene, efo, obi, sio, up, ensembl, bgee)\n` +
		`- prefixHeader — pre-built \`PREFIX …\` block to prepend to your queries\n` +
		`- console logging (log, warn, error, info) — captured output\n` +
		(fsDoNamespace ? `- fs.readFile / fs.writeFile / fs.glob ... — persistent virtual filesystem\n` : "") +
		(preamble ? `\nDomain-specific notes are documented below.\n` : "") +
		`\nThe last expression or return value is the result.\n\n` +
		`ENDPOINT SHAPE:\n${endpointSummary}\n\n` +
		`STAGING: Large SPARQL responses (>30KB) are auto-staged into SQLite. When this happens, ` +
		`sparql.query returns {__staged: true, data_access_id, schema, tables_created, total_rows, message}. ` +
		`Use api.query(data_access_id, sql) in-band, or return the staging object so the caller can use ${prefix}_query_data.\n\n` +
		`OPERATING RULES:\n` +
		`- Start with small SELECT or ASK queries and add LIMIT early.\n` +
		`- Prefer ontology-aware queries over broad triple dumps.\n` +
		`- Use the prefixHeader constant rather than hand-typing PREFIX lines.\n` +
		`- Re-run requests in long conversations instead of relying on older tool output.` +
		(preamble ? `\n\nSERVER NOTES:\n${extractPreambleNotes(preamble)}` : "")
	);
}

interface WrapCodeOptions {
	prefixesSource: string;
	sparqlProxySource: string;
	userCode: string;
	preamble: string | undefined;
	includeFsProxy: boolean;
}

function wrapUserCode(opts: WrapCodeOptions): string {
	const fsProxy = opts.includeFsProxy ? buildFsProxySource() : "";
	return `async () => {
${opts.prefixesSource}
${opts.sparqlProxySource}
${fsProxy}
${opts.preamble ? `\n// --- Preamble (domain notes) ---\n${opts.preamble}\n// --- End preamble ---\n` : ""}
// --- User code ---
${opts.userCode}
// --- End user code ---
}`;
}

function buildPrefixesSource(prefixes: Record<string, string>): string {
	return `
// --- SPARQL prefixes (injected) ---
const prefixes = ${JSON.stringify(prefixes)};
const prefixHeader = ${JSON.stringify(buildPrefixHeader(prefixes))};
// --- End prefixes ---
`;
}

interface ExecutionContext {
	sparqlFetch: SparqlFetchFn;
	options: SparqlExecuteToolOptions;
	loader: WorkerLoaderBinding;
	timeout: number;
	preamble: string | undefined;
	includeFsProxy: boolean;
	sparqlProxySource: string;
	prefixesSource: string;
	buildExecutorFns: (sessionId: string | undefined) => ExecutorFns;
	cache: {
		description: SparqlEndpointDescription | undefined;
		toolDescription: string | undefined;
	};
}

async function ensureDescription(ctx: ExecutionContext): Promise<void> {
	if (!ctx.cache.description) {
		try {
			ctx.cache.description = await probeSparqlEndpoint(ctx.options.endpointUrl, ctx.sparqlFetch);
		} catch (err) {
			ctx.cache.description = {
				endpointUrl: ctx.options.endpointUrl,
				graphs: [],
				predicates: [],
				classes: [],
				warnings: [`Probe failed: ${(err as Error).message}`],
			};
		}
	}
	if (!ctx.cache.toolDescription) {
		ctx.cache.toolDescription = buildDescription(
			ctx.options,
			buildEndpointSummary(ctx.cache.description),
		);
	}
}

async function executeCode(ctx: ExecutionContext, code: string, sessionId: string | undefined) {
	await ensureDescription(ctx);
	const wrappedCode = wrapUserCode({
		prefixesSource: ctx.prefixesSource,
		sparqlProxySource: ctx.sparqlProxySource,
		userCode: code,
		preamble: ctx.preamble,
		includeFsProxy: ctx.includeFsProxy,
	});
	const executor = new DynamicWorkerExecutor({ loader: ctx.loader, timeout: ctx.timeout });
	const result = await executor.execute(wrappedCode, ctx.buildExecutorFns(sessionId));
	return handleExecutorResult(result);
}

function createExecutorFnsBuilder(
	sparqlProxyTool: ReturnType<typeof createSparqlProxyTool>,
	doNamespace: unknown,
	prefix: string,
	fsDoNamespace: unknown,
): (sessionId: string | undefined) => ExecutorFns {
	const queryProxyTool = doNamespace ? createQueryProxyTool({ doNamespace }) : undefined;
	const stageProxyTool = doNamespace
		? createStageProxyTool({ doNamespace, stagingPrefix: prefix })
		: undefined;
	const fsHandlers: ExecutorFns = fsDoNamespace
		? createFsProxyHandlers({
				doNamespace: fsDoNamespace as Parameters<typeof createFsProxyHandlers>[0]["doNamespace"],
			})
		: {};

	return (sessionId: string | undefined) => {
		const ctx: ToolContext = { sql: () => [], sessionId };
		return {
			__sparql_proxy: async (args: unknown) => sparqlProxyTool.handler(toInput(args), ctx),
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

export function createSparqlExecuteTool(options: SparqlExecuteToolOptions): SparqlExecuteToolResult {
	const {
		prefix,
		sparqlFetch,
		doNamespace,
		loader: rawLoader,
		stagingThreshold,
		timeout = 30_000,
		preamble,
		fsDoNamespace,
		prefixes = COMMON_PREFIXES,
	} = options;

	const loader = validateLoader(rawLoader);
	const toolName = `${prefix}_execute`;
	const sparqlProxyTool = createSparqlProxyTool({
		sparqlFetch,
		doNamespace,
		stagingPrefix: prefix,
		stagingThreshold,
	});
	const buildExecutorFns = createExecutorFnsBuilder(sparqlProxyTool, doNamespace, prefix, fsDoNamespace);

	const ctx: ExecutionContext = {
		sparqlFetch,
		options,
		loader,
		timeout,
		preamble,
		includeFsProxy: !!fsDoNamespace,
		sparqlProxySource: buildSparqlProxySource(),
		prefixesSource: buildPrefixesSource(prefixes),
		buildExecutorFns,
		cache: { description: options.description, toolDescription: undefined },
	};

	const initialDescription = buildDescription(options, buildEndpointSummary(options.description));

	return {
		name: toolName,
		description: initialDescription,
		schema: {
			code: z.string().describe(
				"JavaScript code to execute. Use sparql.query() for SELECT/CONSTRUCT/DESCRIBE and sparql.ask() for ASK. " +
				"The last expression or return value becomes the result. " +
				"Example: const rows = await sparql.query(prefixHeader + ' SELECT ?s WHERE { ?s a owl:Class } LIMIT 10'); return rows;",
			),
		},

		async register(
			server: { tool: (...args: unknown[]) => void },
			_opts?: { probeEagerly?: boolean; probeTimeoutMs?: number },
		) {
			// NOTE: `probeEagerly` was experimental — in practice probing the
			// SPARQL endpoint during init added 10-15s to cold session startup
			// (Bgee's Virtuoso is slow on VOID/probe queries). The shape is
			// still probed lazily on first execute and cached thereafter; the
			// tool description carries the standard guidance instead.
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

function handleExecutorResult(
	result: { result?: unknown; error?: string; logs?: string[]; __stagedResults?: Array<Record<string, unknown>> },
) {
	if (result.error) {
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
		const logOutput = result.logs?.length ? `\n\nConsole output:\n${result.logs.join("\n")}` : "";
		return createCodeModeError(ErrorCodes.API_ERROR, `${result.error}${logOutput}`);
	}

	const logOutput = result.logs?.length ? result.logs.join("\n") : undefined;
	const raw = result.result;
	const isStaged =
		raw !== null &&
		typeof raw === "object" &&
		!Array.isArray(raw) &&
		"__staged" in raw &&
		(raw as { __staged: unknown }).__staged === true;
	let responseData: unknown = raw;
	const stagingMeta: Record<string, unknown> = {};
	if (isStaged) {
		const resultObj: Record<string, unknown> = { ...(raw as object) };
		stagingMeta.staged = true;
		stagingMeta.data_access_id = resultObj.data_access_id;
		stagingMeta.tables_created = resultObj.tables_created;
		stagingMeta.total_rows = resultObj.total_rows;
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
