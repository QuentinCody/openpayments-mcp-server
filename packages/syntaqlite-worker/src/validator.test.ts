import { describe, it, expect } from "vitest";
import { SqlValidator, type ValidationResult } from "./validator";
import type { EmscriptenModule, WasmFn } from "./wasm-loader";

/**
 * Build a mock EmscriptenModule that simulates WASM function behavior.
 *
 * The mock uses a shared buffer for input/output, mirroring the real
 * WASM memory model where withInput writes bytes and readAndClearResult
 * reads them back.
 */
function createMockModule(overrides?: {
	diagnosticsResponse?: string;
	diagnosticsCount?: number;
	fmtResponse?: string;
	fmtStatus?: number;
	ddlStatus?: number;
}): EmscriptenModule {
	const heap = new Uint8Array(65536);
	let resultBuf = "";
	let allocOffset = 1024; // start allocations above zero

	const noop = () => 0;

	const mod: EmscriptenModule & Record<`_${string}`, WasmFn | undefined> = {
		HEAPU8: heap,
		loadDynamicLibrary() { /* no-op for tests */ },

		_wasm_alloc(len: number): number {
			const ptr = allocOffset;
			allocOffset += len;
			return ptr;
		},
		_wasm_free: noop,

		_wasm_fmt(ptr: number, len: number): number {
			const input = new TextDecoder().decode(heap.subarray(ptr, ptr + len));
			resultBuf = overrides?.fmtResponse ?? `${input};`;
			return overrides?.fmtStatus ?? 0;
		},

		_wasm_diagnostics(ptr: number, len: number): number {
			if (overrides?.diagnosticsResponse !== undefined) {
				resultBuf = overrides.diagnosticsResponse;
				return overrides.diagnosticsCount ?? 1;
			}
			// Default: no diagnostics (valid SQL)
			resultBuf = "";
			return 0;
		},

		_wasm_result_ptr(): number {
			// Write resultBuf into heap and return pointer
			const encoded = new TextEncoder().encode(resultBuf);
			const ptr = 512; // fixed result area
			heap.set(encoded, ptr);
			return ptr;
		},
		_wasm_result_len(): number {
			return new TextEncoder().encode(resultBuf).length;
		},
		_wasm_result_free(): number {
			resultBuf = "";
			return 0;
		},

		_wasm_set_session_context_ddl(ptr: number, len: number): number {
			return overrides?.ddlStatus ?? 0;
		},
		_wasm_clear_session_context: noop,
		_wasm_set_sqlite_version(ptr: number, len: number): number {
			return 0;
		},
	};

	return mod as EmscriptenModule;
}

describe("SqlValidator", () => {
	it("returns valid for clean SQL with no diagnostics", () => {
		const mod = createMockModule();
		const validator = new SqlValidator(mod);
		const result = validator.validate("SELECT * FROM users");

		expect(result.valid).toBe(true);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("returns diagnostics for problematic SQL", () => {
		const diagnostics = JSON.stringify([
			{
				startOffset: 7,
				endOffset: 20,
				message: "unknown column 'clincal_status'",
				detail: { kind: "unknown_column", column: "clincal_status" },
				severity: "error",
				help: "did you mean 'clinical_status'?",
			},
		]);

		const mod = createMockModule({
			diagnosticsResponse: diagnostics,
			diagnosticsCount: 1,
		});
		const validator = new SqlValidator(mod);
		const result = validator.validate(
			"SELECT clincal_status FROM variants",
		);

		expect(result.valid).toBe(false);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].message).toBe(
			"unknown column 'clincal_status'",
		);
		expect(result.diagnostics[0].help).toBe(
			"did you mean 'clinical_status'?",
		);
		expect(result.diagnostics[0].detail).toEqual({
			kind: "unknown_column",
			column: "clincal_status",
		});
	});

	it("treats warnings as valid", () => {
		const diagnostics = JSON.stringify([
			{
				startOffset: 0,
				endOffset: 5,
				message: "some warning",
				detail: null,
				severity: "warning",
			},
		]);

		const mod = createMockModule({
			diagnosticsResponse: diagnostics,
			diagnosticsCount: 1,
		});
		const validator = new SqlValidator(mod);
		const result = validator.validate("SELECT 1");

		expect(result.valid).toBe(true);
		expect(result.diagnostics).toHaveLength(1);
	});

	it("handles negative diagnostic count as invalid", () => {
		const mod = createMockModule({
			diagnosticsResponse: "",
			diagnosticsCount: -1,
		});
		const validator = new SqlValidator(mod);
		const result = validator.validate("BAD SQL");

		expect(result.valid).toBe(false);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("handles malformed JSON from diagnostics gracefully", () => {
		const mod = createMockModule({
			diagnosticsResponse: "NOT JSON",
			diagnosticsCount: 1,
		});
		const validator = new SqlValidator(mod);
		const result = validator.validate("SELECT 1");

		expect(result.valid).toBe(false);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("setSchema returns true on success", () => {
		const mod = createMockModule({ ddlStatus: 0 });
		const validator = new SqlValidator(mod);
		expect(validator.setSchema("CREATE TABLE t (id INTEGER);")).toBe(true);
	});

	it("setSchema returns false on DDL parse failure", () => {
		const mod = createMockModule({ ddlStatus: 1 });
		const validator = new SqlValidator(mod);
		expect(validator.setSchema("NOT VALID DDL")).toBe(false);
	});

	it("format returns formatted SQL on success", () => {
		const mod = createMockModule({ fmtResponse: "SELECT\n  1;", fmtStatus: 0 });
		const validator = new SqlValidator(mod);
		expect(validator.format("select 1")).toBe("SELECT\n  1;");
	});

	it("format returns null on failure", () => {
		const mod = createMockModule({ fmtResponse: "", fmtStatus: 1 });
		const validator = new SqlValidator(mod);
		expect(validator.format("NOT SQL")).toBeNull();
	});

	describe("formatErrorMessage", () => {
		it("builds message from error diagnostics with help", () => {
			const result: ValidationResult = {
				valid: false,
				diagnostics: [
					{
						severity: "error",
						message: "unknown column 'nme'",
						help: "did you mean 'name'?",
						startOffset: 7,
						endOffset: 10,
						detail: { kind: "unknown_column", column: "nme" },
					},
				],
			};
			expect(SqlValidator.formatErrorMessage(result)).toBe(
				"unknown column 'nme' (did you mean 'name'?)",
			);
		});

		it("joins multiple errors with semicolons", () => {
			const result: ValidationResult = {
				valid: false,
				diagnostics: [
					{
						severity: "error",
						message: "unknown table 'usr'",
						startOffset: 0,
						endOffset: 3,
						detail: { kind: "unknown_table", name: "usr" },
					},
					{
						severity: "error",
						message: "unknown column 'nme'",
						startOffset: 5,
						endOffset: 8,
						detail: { kind: "unknown_column", column: "nme" },
					},
				],
			};
			expect(SqlValidator.formatErrorMessage(result)).toBe(
				"unknown table 'usr'; unknown column 'nme'",
			);
		});

		it("returns empty string for valid results", () => {
			expect(
				SqlValidator.formatErrorMessage({ valid: true, diagnostics: [] }),
			).toBe("");
		});

		it("ignores warnings", () => {
			const result: ValidationResult = {
				valid: true,
				diagnostics: [
					{
						severity: "warning",
						message: "some warning",
						startOffset: 0,
						endOffset: 1,
						detail: null,
					},
				],
			};
			expect(SqlValidator.formatErrorMessage(result)).toBe("");
		});
	});
});
