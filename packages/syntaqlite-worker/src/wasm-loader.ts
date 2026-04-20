/**
 * Workers-compatible loader for the syntaqlite Emscripten WASM module.
 *
 * The upstream syntaqlite JS binding loads via `document.createElement("script")`
 * which doesn't work in Cloudflare Workers. This module replaces that with a
 * converted ES module version of the Emscripten glue JS.
 *
 * Setup: run `node scripts/convert-glue.mjs` to convert the Emscripten glue JS
 * into an importable ES module at `wasm/syntaqlite-runtime.mjs`.
 */

import type { DiagnosticEntry, DiagnosticsResult, FormatOptions, FormatResult } from "syntaqlite";

/** Subset of the Emscripten Module interface used by the Engine. */
export interface EmscriptenModule {
	HEAPU8: Uint8Array;
	loadDynamicLibrary: (
		binary: WebAssembly.Module,
		opts: { loadAsync: boolean; global: boolean; nodelete: boolean },
		scope?: Record<string, WasmFn>,
	) => Promise<void> | void;
	[key: `_${string}`]: WasmFn | undefined;
}

export type WasmFn = (...args: number[]) => number;

/** Resolved WASM functions used by the validator. */
export interface ResolvedFunctions {
	alloc: WasmFn;
	free: WasmFn;
	fmt: WasmFn;
	diagnostics: WasmFn;
	resultPtr: WasmFn;
	resultLen: WasmFn;
	resultFree: WasmFn;
	setSessionContextDdl?: WasmFn;
	clearSessionContext?: WasmFn;
	setSqliteVersion?: WasmFn;
	setDialect?: WasmFn;
}

/**
 * Resolve the _wasm_* exported functions from a loaded Emscripten module.
 */
export function resolveWasmFunctions(mod: EmscriptenModule): ResolvedFunctions {
	function required(name: string): WasmFn {
		const fn = mod[`_${name}`];
		if (typeof fn !== "function") {
			throw new Error(`Missing required WASM function: _${name}`);
		}
		return fn;
	}

	function optional(name: string): WasmFn | undefined {
		const fn = mod[`_${name}`];
		return typeof fn === "function" ? fn : undefined;
	}

	return {
		alloc: required("wasm_alloc"),
		free: required("wasm_free"),
		fmt: required("wasm_fmt"),
		diagnostics: required("wasm_diagnostics"),
		resultPtr: required("wasm_result_ptr"),
		resultLen: required("wasm_result_len"),
		resultFree: required("wasm_result_free"),
		setSessionContextDdl: optional("wasm_set_session_context_ddl"),
		clearSessionContext: optional("wasm_clear_session_context"),
		setSqliteVersion: optional("wasm_set_sqlite_version"),
		setDialect: optional("wasm_set_dialect"),
	};
}

export type { DiagnosticEntry, DiagnosticsResult, FormatOptions, FormatResult };
