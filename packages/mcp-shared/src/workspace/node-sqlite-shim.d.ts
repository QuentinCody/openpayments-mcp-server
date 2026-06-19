// Minimal ambient declaration for `node:sqlite`, used only by the in-memory
// SQLite adapter in the workspace test files. This package's tsconfig restricts
// `types` to `@cloudflare/workers-types` (the Workers runtime), which omits the
// node:* type set — so declaring just this one module keeps the rest of the type
// surface clean and avoids pulling all of @types/node (which would clash with
// Workers globals like Request/Response). An input .d.ts is not emitted to dist.
declare module "node:sqlite" {
	export class DatabaseSync {
		constructor(path: string);
		prepare(sql: string): {
			all(...params: unknown[]): Record<string, unknown>[];
			run(...params: unknown[]): unknown;
		};
	}
}
