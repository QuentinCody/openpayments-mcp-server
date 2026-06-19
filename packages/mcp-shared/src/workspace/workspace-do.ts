// interlinked-tdd: exempt — thin Durable Object shell. All logic lives in the
// unit-tested handleWorkspaceFetch router + the RestStagingDO base; this class
// only wires them to the DO runtime and is integration-tested under wrangler.
import { RestStagingDO } from "../staging/rest-staging-do";
import type { WorkspaceSql } from "./workspace-ops";
import { handleWorkspaceFetch } from "./workspace-router";

/**
 * Shared cross-server data plane (ADR-006 Phase 0). One instance per workspace
 * (`idFromName("ws:" + workspaceId)`) holds every dataset staged during a
 * workflow in ONE SQLite, so an agent can JOIN across servers in a single
 * SELECT. Inherits VirtualFS + per-dataset staging from RestStagingDO and adds
 * the `/ws/stage`, `/ws/query`, `/ws/schema`, `/ws/clear` routes.
 *
 * Hosted as a plain DO today (Phase 0); the same class drops in as a facet
 * under a per-tenant supervisor in Phase 1 — only routing changes, not this code.
 */
export class WorkspaceDO extends RestStagingDO {
	async fetch(request: Request): Promise<Response> {
		const workspaceResponse = await handleWorkspaceFetch(
			this.sql as unknown as WorkspaceSql,
			request,
			// Run mutating ops (stage/clear) inside one DO storage transaction:
			// atomic + far faster than per-statement autocommit. Arrow preserves
			// the `storage` binding for `this`.
			(fn) => this.ctx.storage.transactionSync(fn),
		);
		return workspaceResponse ?? super.fetch(request);
	}
}
