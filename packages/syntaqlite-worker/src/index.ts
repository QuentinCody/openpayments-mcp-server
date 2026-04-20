/**
 * @bio-mcp/syntaqlite-worker
 *
 * Workers-compatible SQL validation using syntaqlite WASM.
 *
 * Usage in a Cloudflare Worker / Durable Object:
 *
 *   import { createSqlValidator } from "@bio-mcp/syntaqlite-worker";
 *   import runtimeWasm from "@bio-mcp/syntaqlite-worker/wasm/syntaqlite-runtime.wasm";
 *   import createModule from "@bio-mcp/syntaqlite-worker/wasm/syntaqlite-runtime.mjs";
 *
 *   const validator = await createSqlValidator(runtimeWasm, createModule);
 *   validator.setSchema('CREATE TABLE users (id INTEGER, name TEXT);');
 *   const result = validator.validate('SELECT nme FROM users');
 *   // result.valid === false
 *   // result.diagnostics[0].help === "did you mean 'name'?"
 */

export { SqlValidator } from "./validator";
export type {
	ValidationResult,
	Diagnostic,
	DiagnosticDetail,
} from "./validator";

export {
	inferredSchemaToDdl,
	pragmaResultsToDdl,
} from "./schema-to-ddl";
export type {
	InferredSchema,
	InferredTable,
	InferredColumn,
	ChildTableRef,
} from "./schema-to-ddl";

export { SchemaValidator } from "./schema-validator";
export type {
	SchemaValidationResult,
	SchemaValidationDiagnostic,
} from "./schema-validator";

export { resolveWasmFunctions } from "./wasm-loader";
export type {
	EmscriptenModule,
	WasmFn,
	ResolvedFunctions,
} from "./wasm-loader";

import { SqlValidator } from "./validator";
import type { EmscriptenModule } from "./wasm-loader";

/** Factory function to load WASM and create a SqlValidator in one step. */
export async function createSqlValidator(
	runtimeWasmBinary: ArrayBuffer,
	createModule: (config: Record<string, unknown>) => Promise<EmscriptenModule>,
): Promise<SqlValidator> {
	const wasmBinary = runtimeWasmBinary;

	const mod = await createModule({
		noInitialRun: true,
		wasmBinary,
		locateFile(path: string) {
			return path;
		},
	});

	return new SqlValidator(mod);
}
