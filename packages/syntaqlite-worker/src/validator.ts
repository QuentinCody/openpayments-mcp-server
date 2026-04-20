/**
 * SqlValidator — schema-aware SQL validation for Cloudflare Workers.
 *
 * Wraps the syntaqlite WASM Engine with a simplified API for validating
 * SQL queries against a known schema (from InferredSchema DDL).
 */

import type {
	EmscriptenModule,
	WasmFn,
	ResolvedFunctions,
} from "./wasm-loader";
import { resolveWasmFunctions } from "./wasm-loader";
import type { DiagnosticEntry } from "syntaqlite";

export interface ValidationResult {
	valid: boolean;
	diagnostics: Diagnostic[];
}

export interface Diagnostic {
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	help?: string;
	startOffset: number;
	endOffset: number;
	detail: DiagnosticDetail | null;
}

export type DiagnosticDetail =
	| { kind: "unknown_table"; name: string }
	| { kind: "unknown_column"; column: string; table?: string }
	| { kind: "unknown_function"; name: string }
	| { kind: "function_arity"; name: string; expected: number[]; got: number };

/**
 * SqlValidator provides schema-aware SQL validation using syntaqlite WASM.
 *
 * Lifecycle:
 * 1. Construct with a loaded EmscriptenModule
 * 2. Optionally call setSchema() with CREATE TABLE DDL
 * 3. Call validate() on SQL queries — returns diagnostics with suggestions
 *
 * The validator is stateful: the schema context persists across validate() calls
 * until setSchema() or clearSchema() is called.
 */
export class SqlValidator {
	private readonly fns: ResolvedFunctions;
	private readonly mod: EmscriptenModule;
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	constructor(mod: EmscriptenModule) {
		this.mod = mod;
		this.fns = resolveWasmFunctions(mod);
	}

	/**
	 * Set the schema context for validation. Pass CREATE TABLE DDL statements.
	 * Returns true if the DDL was accepted, false if it had parse errors.
	 */
	setSchema(ddl: string): boolean {
		if (!this.fns.setSessionContextDdl) return false;
		const status = this.withInput(ddl, (ptr, len) =>
			this.fns.setSessionContextDdl!(ptr, len),
		);
		this.readAndClearResult(); // consume result buffer
		return status === 0;
	}

	/** Clear the schema context. Subsequent validate() calls won't check column/table names. */
	clearSchema(): void {
		if (this.fns.clearSessionContext) {
			this.fns.clearSessionContext();
		}
	}

	/** Pin validation to a specific SQLite version (e.g., "3.44.0"). */
	setSqliteVersion(version: string): void {
		if (!this.fns.setSqliteVersion) return;
		const status = this.withInput(version, (ptr, len) =>
			this.fns.setSqliteVersion!(ptr, len),
		);
		const detail = this.readAndClearResult();
		if (status !== 0) {
			throw new Error(
				detail || `setSqliteVersion failed with status ${status}`,
			);
		}
	}

	/**
	 * Validate a SQL query against the current schema context.
	 * Returns structured diagnostics with "did you mean?" suggestions.
	 */
	validate(sql: string): ValidationResult {
		if (!this.fns.diagnostics) {
			return { valid: true, diagnostics: [] };
		}

		const count = this.withInput(sql, (ptr, len) =>
			this.fns.diagnostics(ptr, len, 1),
		);
		const text = this.readAndClearResult();

		if (count < 0) {
			return { valid: false, diagnostics: [] };
		}
		if (count === 0) {
			return { valid: true, diagnostics: [] };
		}

		let entries: DiagnosticEntry[];
		try {
			entries = JSON.parse(text) as DiagnosticEntry[];
		} catch {
			return { valid: false, diagnostics: [] };
		}
		const diagnostics: Diagnostic[] = entries.map((e) => ({
			severity: e.severity,
			message: e.message,
			help: e.help,
			startOffset: e.startOffset,
			endOffset: e.endOffset,
			detail: e.detail as DiagnosticDetail | null,
		}));

		const hasErrors = diagnostics.some((d) => d.severity === "error");
		return { valid: !hasErrors, diagnostics };
	}

	/**
	 * Format a SQL query using syntaqlite's formatter.
	 * Returns null if formatting fails.
	 */
	format(sql: string): string | null {
		const status = this.withInput(sql, (ptr, len) =>
			this.fns.fmt(ptr, len, 80, 2, 1, 1),
		);
		const text = this.readAndClearResult();
		return status === 0 ? text : null;
	}

	/** Build a human-readable error message from validation diagnostics. */
	static formatErrorMessage(result: ValidationResult): string {
		const errors = result.diagnostics.filter((d) => d.severity === "error");
		if (errors.length === 0) return "";

		return errors
			.map((e) => (e.help ? `${e.message} (${e.help})` : e.message))
			.join("; ");
	}

	// -- Internal helpers matching syntaqlite Engine patterns --

	private withInput<T>(str: string, fn: (ptr: number, len: number) => T): T {
		const input = this.encoder.encode(str);
		const ptr = this.fns.alloc(input.length);
		if (input.length > 0 && ptr === 0) throw new Error("WASM allocation failed");
		if (input.length > 0) this.heapU8().set(input, ptr);
		try {
			return fn(ptr, input.length);
		} finally {
			this.fns.free(ptr, input.length);
		}
	}

	private readAndClearResult(): string {
		const ptr = this.fns.resultPtr();
		const len = this.fns.resultLen();
		const text =
			len === 0
				? ""
				: this.decoder.decode(this.heapU8().subarray(ptr, ptr + len));
		this.fns.resultFree();
		return text;
	}

	private heapU8(): Uint8Array {
		return this.mod.HEAPU8;
	}
}
