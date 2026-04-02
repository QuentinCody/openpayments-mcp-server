/**
 * Filesystem proxy host handlers — routes V8 isolate fs.* calls
 * through the Durable Object's /fs/* endpoints.
 *
 * Returns a record of handler functions keyed by RPC name (__fs_read, etc.)
 * that are merged into the executor's function map in execute-tool.ts.
 *
 * The handlers communicate with a well-known DO instance (`__fs__`)
 * via HTTP fetch, keeping the filesystem isolated from staging data.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DurableObjectStub {
	fetch(req: Request): Promise<Response>;
}

interface DurableObjectNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): DurableObjectStub;
}

interface FsResponse {
	success: boolean;
	error?: string;
	data?: unknown;
}

/** Handler function shape matching ExecutorFns in execute-tool.ts */
type FsHandler = (args: unknown) => Promise<unknown>;

// ---------------------------------------------------------------------------
// DO communication
// ---------------------------------------------------------------------------

const FS_DO_NAME = "__fs__";

async function fsFetch(
	doNamespace: DurableObjectNamespace,
	action: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const doId = doNamespace.idFromName(FS_DO_NAME);
	const doStub = doNamespace.get(doId);
	const resp = await doStub.fetch(
		new Request(`http://localhost/fs/${action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	const result: FsResponse = await resp.json() as FsResponse;
	if (!result.success) {
		return { __fs_error: true, message: result.error ?? `fs.${action} failed` };
	}
	return result.data;
}

function toBody(args: unknown): Record<string, unknown> {
	if (args !== null && typeof args === "object" && !Array.isArray(args)) {
		return args as Record<string, unknown>;
	}
	return {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FsProxyHandlerOptions {
	/** DO namespace — uses idFromName("__fs__") for the shared filesystem DO */
	doNamespace: DurableObjectNamespace;
}

/**
 * Create handler functions for all __fs_* RPC calls from V8 isolates.
 * Merge the returned record into executorFns in createExecuteTool().
 */
export function createFsProxyHandlers(
	options: FsProxyHandlerOptions,
): Record<string, FsHandler> {
	const { doNamespace } = options;

	return {
		__fs_read: async (args: unknown) =>
			fsFetch(doNamespace, "read", toBody(args)),

		__fs_write: async (args: unknown) =>
			fsFetch(doNamespace, "write", toBody(args)),

		__fs_append: async (args: unknown) =>
			fsFetch(doNamespace, "append", toBody(args)),

		__fs_mkdir: async (args: unknown) =>
			fsFetch(doNamespace, "mkdir", toBody(args)),

		__fs_readdir: async (args: unknown) =>
			fsFetch(doNamespace, "readdir", toBody(args)),

		__fs_stat: async (args: unknown) =>
			fsFetch(doNamespace, "stat", toBody(args)),

		__fs_exists: async (args: unknown) =>
			fsFetch(doNamespace, "exists", toBody(args)),

		__fs_rm: async (args: unknown) =>
			fsFetch(doNamespace, "rm", toBody(args)),

		__fs_glob: async (args: unknown) =>
			fsFetch(doNamespace, "glob", toBody(args)),
	};
}
