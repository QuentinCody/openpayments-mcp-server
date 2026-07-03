// interlinked-tdd: exempt — runtime-coupled V8 isolate executor (requires the
// Cloudflare Worker Loader binding). Inlined verbatim from @cloudflare/codemode
// and integration-tested under wrangler, not in unit tests.
//
// Inlined from @cloudflare/codemode v0.1.1 — avoids bundling zod-to-ts →
// typescript (CJS, uses __filename, crashes Workers).
// Only DynamicWorkerExecutor + ToolDispatcher are needed.

import { RpcTarget } from "cloudflare:workers";

export type ExecutorFns = Record<
	string,
	(...args: unknown[]) => Promise<unknown>
>;

export interface ExecutorResult {
	result?: unknown;
	error?: string;
	logs?: string[];
	__stagedResults?: Array<Record<string, unknown>>;
}

/** RPC target that dispatches tool calls from the isolate back to the host. */
export class ToolDispatcher extends RpcTarget {
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
			return JSON.stringify({
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/** Minimal interface for the Cloudflare Worker Loader binding. */
export interface WorkerLoaderBinding {
	get(
		name: string,
		factory: () => unknown,
	): {
		getEntrypoint(): {
			evaluate(dispatcher: ToolDispatcher): Promise<ExecutorResult>;
		};
	};
}

/** Executes code in an isolated V8 Worker via the Worker Loader binding. */
export class DynamicWorkerExecutor {
	#loader: WorkerLoaderBinding;
	#timeout: number;

	constructor(options: { loader: WorkerLoaderBinding; timeout?: number }) {
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
			"    console.log = (...a) => { __logs.push(__join(...a)); };",
			'    console.warn = (...a) => { __logs.push("[warn] " + __join(...a)); };',
			'    console.error = (...a) => { __logs.push("[error] " + __join(...a)); };',
			"    console.info = (...a) => { __logs.push(__join(...a)); };",
			'    console.debug = (...a) => { __logs.push("[debug] " + __join(...a)); };',
			'    console.trace = (...a) => { __logs.push("[trace] " + __join(...a)); };',
			"    console.dir = (v) => { __logs.push(__fmt(v)); };",
			"    console.table = (v) => { __logs.push(__fmt(v)); };",
			'    console.assert = (cond, ...a) => { if (!cond) __logs.push("[assert] " + __join(...a)); };',
			'    const __c = {}; console.count = (l = "default") => { __c[l] = (__c[l] || 0) + 1; __logs.push(l + ": " + __c[l]); };',
			'    console.countReset = (l = "default") => { __c[l] = 0; };',
			"    const __t = {};",
			'    console.time = (l = "default") => { __t[l] = Date.now(); };',
			'    console.timeEnd = (l = "default") => { const d = __t[l] ? Date.now() - __t[l] : 0; __logs.push(l + ": " + d + "ms"); delete __t[l]; };',
			'    console.timeLog = (l = "default", ...a) => { const d = __t[l] ? Date.now() - __t[l] : 0; __logs.push(l + ": " + d + "ms" + (a.length ? " " + __join(...a) : "")); };',
			"    console.group = (...a) => { if (a.length) __logs.push(__join(...a)); };",
			"    console.groupEnd = () => {};",
			"    console.groupCollapsed = (...a) => { if (a.length) __logs.push(__join(...a)); };",
			"    console.clear = () => {};",
			"    const codemode = new Proxy({}, {",
			"      get: (_, toolName) => async (args) => {",
			"        const resJson = await dispatcher.call(String(toolName), JSON.stringify(args ?? {}));",
			"        var data; try { data = JSON" +
				".parse(resJson); } catch (e) { throw new Error('Failed to parse tool response: ' + e.message); }",
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
			"      var __safeResult = (result && typeof result === 'object') ? JSON.parse(JSON.stringify(result)) : result;",
			"      return { result: __safeResult, logs: __logs, __stagedResults: typeof __stagedResults !== 'undefined' && __stagedResults.length > 0 ? __stagedResults : undefined };",
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
			return {
				result: undefined,
				error: response.error,
				logs: response.logs,
				__stagedResults: response.__stagedResults,
			};
		}
		return {
			result: response.result,
			logs: response.logs,
			__stagedResults: response.__stagedResults,
		};
	}
}
