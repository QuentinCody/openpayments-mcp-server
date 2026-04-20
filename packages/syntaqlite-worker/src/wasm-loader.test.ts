import { describe, it, expect } from "vitest";
import { resolveWasmFunctions, type EmscriptenModule, type WasmFn } from "./wasm-loader";

describe("resolveWasmFunctions", () => {
	function makeMockModule(
		fns: Record<string, (...args: number[]) => number>,
	): EmscriptenModule {
		const mod: EmscriptenModule & Record<`_${string}`, WasmFn | undefined> = {
			HEAPU8: new Uint8Array(0),
			loadDynamicLibrary: () => {},
		};
		for (const [name, fn] of Object.entries(fns)) {
			mod[`_${name}`] = fn;
		}
		return mod;
	}

	const noop = () => 0;

	const requiredFns: Record<string, (...args: number[]) => number> = {
		wasm_alloc: noop,
		wasm_free: noop,
		wasm_fmt: noop,
		wasm_diagnostics: noop,
		wasm_result_ptr: noop,
		wasm_result_len: noop,
		wasm_result_free: noop,
	};

	it("resolves all required functions", () => {
		const mod = makeMockModule(requiredFns);
		const fns = resolveWasmFunctions(mod);

		expect(fns.alloc).toBe(noop);
		expect(fns.free).toBe(noop);
		expect(fns.fmt).toBe(noop);
		expect(fns.diagnostics).toBe(noop);
		expect(fns.resultPtr).toBe(noop);
		expect(fns.resultLen).toBe(noop);
		expect(fns.resultFree).toBe(noop);
	});

	it("resolves optional functions when present", () => {
		const mod = makeMockModule({
			...requiredFns,
			wasm_set_session_context_ddl: noop,
			wasm_clear_session_context: noop,
			wasm_set_sqlite_version: noop,
			wasm_set_dialect: noop,
		});
		const fns = resolveWasmFunctions(mod);

		expect(fns.setSessionContextDdl).toBe(noop);
		expect(fns.clearSessionContext).toBe(noop);
		expect(fns.setSqliteVersion).toBe(noop);
		expect(fns.setDialect).toBe(noop);
	});

	it("returns undefined for missing optional functions", () => {
		const mod = makeMockModule(requiredFns);
		const fns = resolveWasmFunctions(mod);

		expect(fns.setSessionContextDdl).toBeUndefined();
		expect(fns.clearSessionContext).toBeUndefined();
		expect(fns.setSqliteVersion).toBeUndefined();
		expect(fns.setDialect).toBeUndefined();
	});

	it("throws when a required function is missing", () => {
		const { wasm_fmt: _, ...incomplete } = requiredFns;
		const mod = makeMockModule(incomplete);

		expect(() => resolveWasmFunctions(mod)).toThrow(
			"Missing required WASM function: _wasm_fmt",
		);
	});
});
