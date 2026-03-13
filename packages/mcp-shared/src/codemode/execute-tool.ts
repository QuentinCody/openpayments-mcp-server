/**
 * Execute tool factory — creates a `<prefix>_execute` tool for Code Mode.
 *
 * Uses DynamicWorkerExecutor (inlined from @cloudflare/codemode) to run user
 * code in a sandboxed V8 isolate via the Worker Loader binding.
 *
 * The isolate gets:
 * - codemode.__api_proxy() — routes API calls through server HTTP layer
 * - Pre-injected catalog search helpers (searchSpec, listCategories, etc.)
 * - Pre-injected api.get/api.post wrappers
 * - console.log() capture
 *
 * API keys never enter the isolate — all HTTP goes through the host's apiFetch.
 */

import { z } from "zod";
import { RpcTarget } from "cloudflare:workers";
import type { ApiCatalog, ApiFetchFn } from "./catalog";
import { buildCatalogSearchSource } from "./catalog-search";
import type { ResolvedSpec } from "./openapi-resolver";
import { buildOpenApiSearchSource } from "./openapi-search";
import { buildApiProxySource } from "./api-proxy";
import { createApiProxyTool, createQueryProxyTool, type ApiProxyToolOptions } from "../tools/api-proxy";
import { createCodeModeResponse, createCodeModeError, ErrorCodes } from "./response";

// ---------------------------------------------------------------------------
// Inlined from @cloudflare/codemode v0.1.1 — avoids bundling zod-to-ts →
// typescript (CJS, uses __filename, crashes Workers).
// Only DynamicWorkerExecutor + ToolDispatcher are needed.
// ---------------------------------------------------------------------------

type ExecutorFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

interface ExecutorResult {
  result?: unknown;
  error?: string;
  logs?: string[];
  __stagedResults?: Array<Record<string, unknown>>;
}

/** RPC target that dispatches tool calls from the isolate back to the host. */
class ToolDispatcher extends RpcTarget {
  #fns: ExecutorFns;
  constructor(fns: ExecutorFns) {
    super();
    this.#fns = fns;
  }
  async call(name: string, argsJson: string): Promise<string> {
    const fn = this.#fns[name];
    if (!fn) return JSON.stringify({ error: `Tool "${name}" not found` });
    try {
      const result = await fn(argsJson ? JSON.parse(argsJson) : {});
      return JSON.stringify({ result });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Executes code in an isolated V8 Worker via the Worker Loader binding. */
class DynamicWorkerExecutor {
  #loader: any;
  #timeout: number;

  constructor(options: { loader: unknown; timeout?: number }) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30_000;
  }

  async execute(code: string, fns: ExecutorFns): Promise<ExecutorResult> {
    const timeoutMs = this.#timeout;
    const modulePrefix = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(dispatcher) {",
      "    const __logs = [];",
      "    var __stagedResults = [];",
      '    const __fmt = (v) => typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();',
      '    const __join = (...a) => a.map(__fmt).join(" ");',
      '    console.log = (...a) => { __logs.push(__join(...a)); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + __join(...a)); };',
      '    console.error = (...a) => { __logs.push("[error] " + __join(...a)); };',
      '    console.info = (...a) => { __logs.push(__join(...a)); };',
      '    console.debug = (...a) => { __logs.push("[debug] " + __join(...a)); };',
      '    console.trace = (...a) => { __logs.push("[trace] " + __join(...a)); };',
      '    console.dir = (v) => { __logs.push(__fmt(v)); };',
      '    console.table = (v) => { __logs.push(__fmt(v)); };',
      '    console.assert = (cond, ...a) => { if (!cond) __logs.push("[assert] " + __join(...a)); };',
      '    const __c = {}; console.count = (l = "default") => { __c[l] = (__c[l] || 0) + 1; __logs.push(l + ": " + __c[l]); };',
      '    console.countReset = (l = "default") => { __c[l] = 0; };',
      '    const __t = {};',
      '    console.time = (l = "default") => { __t[l] = Date.now(); };',
      '    console.timeEnd = (l = "default") => { const d = __t[l] ? Date.now() - __t[l] : 0; __logs.push(l + ": " + d + "ms"); delete __t[l]; };',
      '    console.timeLog = (l = "default", ...a) => { const d = __t[l] ? Date.now() - __t[l] : 0; __logs.push(l + ": " + d + "ms" + (a.length ? " " + __join(...a) : "")); };',
      '    console.group = (...a) => { if (a.length) __logs.push(__join(...a)); };',
      '    console.groupEnd = () => {};',
      '    console.groupCollapsed = (...a) => { if (a.length) __logs.push(__join(...a)); };',
      '    console.clear = () => {};',
      "    const codemode = new Proxy({}, {",
      "      get: (_, toolName) => async (args) => {",
      "        const resJson = await dispatcher.call(String(toolName), JSON.stringify(args ?? {}));",
      "        const data = JSON.parse(resJson);",
      "        if (data.error) throw new Error(data.error);",
      "        return data.result;",
      "      }",
      "    });",
      "",
      "    try {",
      "      const result = await Promise.race([",
      "        (",
    ].join("\n");

    const moduleSuffix = [
      ")(),",
      `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${timeoutMs}))`,
      "      ]);",
      "      return { result, logs: __logs, __stagedResults: typeof __stagedResults !== 'undefined' && __stagedResults.length > 0 ? __stagedResults : undefined };",
      "    } catch (err) {",
      "      return { result: undefined, error: err.message, logs: __logs, __stagedResults: typeof __stagedResults !== 'undefined' && __stagedResults.length > 0 ? __stagedResults : undefined };",
      "    }",
      "  }",
      "}",
    ].join("\n");

    const executorModule = modulePrefix + code + moduleSuffix;
    const dispatcher = new ToolDispatcher(fns);

    const response = await this.#loader
      .get(`codemode-${crypto.randomUUID()}`, () => ({
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "executor.js",
        modules: { "executor.js": executorModule },
        globalOutbound: null,
      }))
      .getEntrypoint()
      .evaluate(dispatcher);

    if (response.error) {
      return { result: undefined, error: response.error, logs: response.logs, __stagedResults: response.__stagedResults };
    }
    return { result: response.result, logs: response.logs, __stagedResults: response.__stagedResults };
  }
}

// ---------------------------------------------------------------------------
// Execute tool factory
// ---------------------------------------------------------------------------

export interface ExecuteToolOptions {
  /** Tool name prefix (e.g., "gtex" → "gtex_execute") */
  prefix: string;
  /** The legacy API catalog (optional when using OpenAPI mode) */
  catalog?: ApiCatalog;
  /** Resolved OpenAPI spec injected into the isolate in place of the catalog */
  openApiSpec?: ResolvedSpec;
  /** Server's HTTP fetch adapter */
  apiFetch: ApiFetchFn;
  /** DO namespace for auto-staging large responses */
  doNamespace?: unknown;
  /** Worker Loader binding for V8 isolate creation */
  loader: unknown;
  /** Byte threshold for auto-staging (default 100KB) */
  stagingThreshold?: number;
  /** Execution timeout in ms (default 30000) */
  timeout?: number;
  /** Optional JavaScript source injected into the isolate before user code.
   *  Use to provide domain-specific helper functions (e.g. stats.computePRR). */
  preamble?: string;
}

/**
 * Build the user code wrapped with spec search + API proxy helpers.
 */
function wrapUserCode(searchSource: string, userCode: string, preamble?: string): string {
  const apiProxy = buildApiProxySource();

  return `async () => {
${searchSource}
${apiProxy}
${preamble ? `\n// --- Preamble (domain helpers) ---\n${preamble}\n// --- End preamble ---\n` : ""}
// --- User code ---
${userCode}
// --- End user code ---
}`;
}

/**
 * Create an execute tool registration object.
 */
export function createExecuteTool(options: ExecuteToolOptions) {
  const {
    prefix,
    catalog,
    openApiSpec,
    apiFetch,
    doNamespace,
    loader,
    stagingThreshold,
    timeout = 30_000,
    preamble,
  } = options;

  if (!catalog && !openApiSpec) {
    throw new Error("createExecuteTool requires either 'catalog' or 'openApiSpec'");
  }

  const toolName = `${prefix}_execute`;
  const apiName = catalog?.name || openApiSpec?.info.title || prefix;
  const totalOperations = openApiSpec
    ? Object.values(openApiSpec.paths).reduce((count, pathItem) => {
        if (!pathItem || typeof pathItem !== "object") return count;
        return count + Object.keys(pathItem).filter((method) =>
          ["get", "post", "put", "delete", "patch", "options", "head", "trace"].includes(method),
        ).length;
      }, 0)
    : catalog!.endpointCount;
  const searchSource = openApiSpec
    ? buildOpenApiSearchSource(JSON.stringify(openApiSpec))
    : buildCatalogSearchSource(JSON.stringify(catalog));
  const notesSection = catalog?.notes ? `\n\nNOTES:\n${catalog.notes}` : "";
  const searchDescription = openApiSpec
    ? `- searchSpec(query) / searchPaths(query) — search the OpenAPI spec\n` +
      `- listCategories() / listTags() — inspect tags/categories\n` +
      `- getEndpoint(path, method?) / getOperation(idOrPath) — get endpoint docs\n` +
      `- describeEndpoint(path, method?) / describeOperation(idOrPath) — format endpoint docs\n` +
      `- spec — full frozen OpenAPI spec object\n`
    : `- searchSpec(query) — search the API catalog\n` +
      `- listCategories() — list endpoint categories\n` +
      `- getEndpoint(path) — get full endpoint docs\n`;

  // Create the __api_proxy handler
  const apiProxyToolOpts: ApiProxyToolOptions = {
    apiFetch,
    catalog,
    openApiSpec,
    doNamespace,
    stagingPrefix: prefix,
    stagingThreshold,
  };
  const apiProxyTool = createApiProxyTool(apiProxyToolOpts);

  // Build the __query_proxy handler (only available if DO namespace exists)
  const queryProxyTool = doNamespace
    ? createQueryProxyTool({ doNamespace })
    : undefined;

  // Build the function map for the executor
  const executorFns: ExecutorFns = {
    __api_proxy: async (args: unknown) => {
      const input = (args ?? {}) as Record<string, unknown>;
      return apiProxyTool.handler(input, {} as any);
    },
    __query_proxy: async (args: unknown) => {
      if (!queryProxyTool) {
        return { __query_error: true, message: "Staged data querying is not available (no DO namespace configured)" };
      }
      const input = (args ?? {}) as Record<string, unknown>;
      return queryProxyTool.handler(input, {} as any);
    },
  };

  return {
    name: toolName,
    apiProxyTool,
    description:
      `Execute JavaScript code against the ${apiName} API (${totalOperations} ${openApiSpec ? "operations" : "endpoints"}). ` +
      `Code runs in a sandboxed V8 isolate with:\n` +
      `- api.get(path, params) — make GET requests (path params auto-interpolated from params object)\n` +
      `- api.post(path, body, params) — make POST requests\n` +
      searchDescription +
      `- console.log() — output logging\n` +
      (preamble ? `\nDomain-specific helper functions are also available — see the catalog notes for details.\n` : "") +
      `\nUse ${prefix}_search first to discover endpoints, then write code here to call them.\n` +
      `The last expression or return value is the result.\n\n` +
      `STAGING: Large responses (>30KB) are auto-staged into SQLite. When this happens, ` +
      `api.get/api.post returns {__staged: true, data_access_id, schema, tables_created, total_rows, message}. ` +
      `Scalar properties from the original response (.count, .total, .meta) are preserved on the staged object.\n\n` +
      `When staging occurs:\n` +
      `1. Check result.__staged === true\n` +
      `2. Read any preserved scalars (result.count, result.total, etc.)\n` +
      `3. Return the staging metadata — the caller will use ${prefix}_query_data with the data_access_id to explore the data with SQL\n\n` +
      `DO NOT try to access .results, .data, .entries, .items on a staged response — those arrays were replaced by SQLite tables.\n\n` +
      `For advanced use: api.query(data_access_id, sql) and db.queryStaged(data_access_id, sql) are available to query staged data ` +
      `within the same execution (returns {results, row_count}, max 1000 rows, SELECT only). ` +
      `This is useful when you need to aggregate or filter staged data before returning.\n\n` +
      `IMPORTANT: Use limit/pagination params to keep responses small. If you need large datasets, let them auto-stage and return the staging info.` +
      notesSection,
    schema: {
      code: z.string().describe(
        "JavaScript code to execute. Use api.get/api.post for API calls. " +
          "The last expression or explicit return value becomes the result. " +
          "Example: return await api.get('/dataset/tissueSiteDetail')",
      ),
    },

    register(server: { tool: (...args: unknown[]) => void }) {
      const description = this.description;
      const schema = this.schema;

      server.tool(toolName, description, schema, async (input: { code: string }) => {
        const code = input.code?.trim();
        if (!code) {
          return createCodeModeError(ErrorCodes.INVALID_ARGUMENTS, "code is required");
        }

        try {
          const wrappedCode = wrapUserCode(searchSource, code, preamble);

          const executor = new DynamicWorkerExecutor({ loader, timeout });
          const result = await executor.execute(wrappedCode, executorFns);

          if (result.error) {
            // If the error was caused by accessing staged data arrays, recover
            // the staging metadata and return it as a success response instead.
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

          // Detect staging metadata in the result and hoist to _meta so
          // downstream clients can find data_access_id without digging into data.
          // Also strip large redundant fields (schema, _staging) to stay under
          // the 100KB structuredContent transport limit.
          const resultObj = result.result as Record<string, unknown> | null | undefined;
          const isStaged = resultObj && typeof resultObj === "object" && resultObj.__staged === true;
          let responseData: unknown = result.result;
          const stagingMeta: Record<string, unknown> = {};

          if (isStaged) {
            stagingMeta.staged = true;
            stagingMeta.data_access_id = resultObj.data_access_id;
            stagingMeta.tables_created = resultObj.tables_created;
            stagingMeta.total_rows = resultObj.total_rows;

            // Strip large fields that are available via get_schema tool
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
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return createCodeModeError(
            ErrorCodes.UNKNOWN_ERROR,
            `${prefix}_execute failed: ${message}`,
          );
        }
      });
    },
  };
}
