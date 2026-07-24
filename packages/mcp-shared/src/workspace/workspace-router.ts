/**
 * HTTP router for `WorkspaceDO`. Kept separate from both the ops (pure logic)
 * and the DO class (runtime shell) so it can be unit-tested with an in-memory
 * SQLite — the DO class is then a trivial wrapper that calls this with
 * `this.ctx.storage.sql` and falls back to the inherited RestStagingDO routes.
 */
import { canonicalJson, sha256Hex } from "../provenance/provenance";
import type { SchemaHints } from "../staging/schema-inference";
import {
	clearWorkspace,
	queryWorkspace,
	stageDataset,
	type WorkspaceSql,
	workspaceSchema,
} from "./workspace-ops";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A synchronous transaction runner (DO `ctx.storage.transactionSync`).
 * Defaults to a pass-through so the router stays unit-testable without a DO. */
export type TxnRunner = <T>(fn: () => T) => T;
const PASSTHROUGH_TXN: TxnRunner = (fn) => fn();

/**
 * Route a `/ws/*` request to the workspace ops. Returns `null` for any other
 * path so the caller (`WorkspaceDO.fetch`) can defer to `super.fetch` (the
 * inherited `/process`, `/query`, `/schema`, `/fs/*` routes).
 *
 * `runInTransaction` wraps the mutating ops so staging (many DDL + INSERT)
 * commits atomically — a mid-materialization failure rolls back, leaving no
 * orphan tables without a manifest row — and ~10-50x faster than per-statement
 * autocommit. Defaults to a pass-through for unit tests.
 */
export async function handleWorkspaceFetch(
	sql: WorkspaceSql,
	request: Request,
	runInTransaction: TxnRunner = PASSTHROUGH_TXN,
): Promise<Response | null> {
	const url = new URL(request.url);
	const { pathname } = url;
	if (!pathname.startsWith("/ws/")) return null;

	try {
		if (pathname === "/ws/stage" && request.method === "POST") {
			const body = (await request.json()) as {
				dataset: string;
				data: unknown;
				schema_hints?: SchemaHints;
				source_tool?: string;
			};
			const payloadHash = `sha256:${await sha256Hex(canonicalJson(body.data))}`;
			const handle = runInTransaction(() =>
				stageDataset(sql, {
					dataset: body.dataset,
					data: body.data,
					schemaHints: body.schema_hints,
					sourceTool: body.source_tool,
					payloadHash,
				}),
			);
			return json({ success: true, ...handle });
		}

		if (pathname === "/ws/query" && request.method === "POST") {
			const body = (await request.json()) as { sql: string; limit?: number };
			const result = queryWorkspace(sql, { sql: body.sql, limit: body.limit });
			return json({ success: true, ...result });
		}

		if (pathname === "/ws/schema" && request.method === "GET") {
			const ds = url.searchParams.get("dataset") ?? undefined;
			return json({ success: true, ...workspaceSchema(sql, ds) });
		}

		if (pathname === "/ws/clear" && request.method === "POST") {
			runInTransaction(() => clearWorkspace(sql));
			return json({ success: true });
		}

		return json(
			{
				success: false,
				error: `Unknown workspace route: ${request.method} ${pathname}`,
			},
			404,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ success: false, error: message }, 400);
	}
}
