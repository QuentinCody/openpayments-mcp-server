/**
 * Hidden __paginate_proxy tool — backs the isolate's `api.getAll(...)`.
 *
 * Walks every page of an endpoint on the host side via {@link paginateAll},
 * returns the combined records plus a {@link Completeness} verdict, and
 * auto-stages the set into SQLite when it's large. This is the deterministic
 * answer to silent under-counting: agents call one helper and get the WHOLE
 * result (or an explicit truncation reason), not just page one.
 */

import { z } from "zod";
import type { ApiFetchFn } from "../codemode/catalog";
import {
	type PageFetcher,
	type PaginateOptions,
	paginateAll,
} from "../codemode/paginate";
import type { ToolEntry } from "../registry/types";
import { shouldStage, stageToDoAndRespond } from "../staging/utils";
import {
	buildStageOptions,
	interpolatePath,
	isRecord,
	validatePath,
} from "./api-proxy";

export interface PaginateProxyToolOptions {
	/** Server's HTTP fetch adapter (the same one api.get uses). */
	apiFetch: ApiFetchFn;
	/** DO namespace for auto-staging large combined result sets. */
	doNamespace?: unknown;
	/** Prefix for data access IDs (e.g., "entrez"). */
	stagingPrefix?: string;
	/** Byte threshold for auto-staging the combined items array. */
	stagingThreshold?: number;
	/** WorkspaceDO namespace — when set and `ctx.workspace` is present, staging routes there (ADR-006 Phase 0). */
	workspaceNamespace?: unknown;
}

/** Create the hidden __paginate_proxy tool entry. */
export function createPaginateProxyTool(
	options: PaginateProxyToolOptions,
): ToolEntry {
	const {
		apiFetch,
		doNamespace,
		stagingPrefix,
		stagingThreshold,
		workspaceNamespace,
	} = options;

	return {
		name: "__paginate_proxy",
		description:
			"Exhaustively paginate an API endpoint from the V8 isolate. Internal only.",
		hidden: true,
		schema: {
			path: z.string(),
			params: z.record(z.string(), z.unknown()).optional(),
			opts: z.record(z.string(), z.unknown()).optional(),
		},
		handler: async (input, ctx) => {
			const rawPath = String(input.path || "/");
			const rawParams: Record<string, unknown> = isRecord(input.params)
				? input.params
				: {};
			const opts = (isRecord(input.opts) ? input.opts : {}) as PaginateOptions;

			try {
				validatePath(rawPath);
				// Path params are fixed across pages; interpolate once, paginate the rest.
				const { path, queryParams } = interpolatePath(rawPath, rawParams);
				const fetchPage: PageFetcher = async (params) => {
					const result = await apiFetch({
						method: "GET",
						path,
						params: Object.keys(params).length > 0 ? params : undefined,
					});
					return result.data;
				};

				const pag = await paginateAll(fetchPage, queryParams, opts);
				const itemsBytes = JSON.stringify(pag.items).length;

				if (
					doNamespace &&
					stagingPrefix &&
					shouldStage(itemsBytes, stagingThreshold)
				) {
					const staged = await stageToDoAndRespond(
						pag.items,
						doNamespace as Parameters<typeof stageToDoAndRespond>[1],
						stagingPrefix,
						undefined,
						undefined,
						stagingPrefix,
						ctx?.sessionId,
						buildStageOptions(
							ctx,
							workspaceNamespace,
							stagingPrefix,
							pag.total_available,
						),
					);
					return {
						__staged: true,
						data_access_id: staged.dataAccessId,
						schema: staged.schema,
						tables_created: staged.tablesCreated,
						total_rows: staged.totalRows,
						_staging: staged._staging,
						pages: pag.pages,
						completeness: pag.completeness,
						...(pag.total_available !== undefined
							? { total_available: pag.total_available }
							: {}),
						message: `Paginated ${pag.pages} page(s) → ${pag.items.length} record(s), auto-staged into SQLite. Use api.query("${staged.dataAccessId}", sql) or the query_data tool.`,
					};
				}

				return {
					items: pag.items,
					count: pag.items.length,
					pages: pag.pages,
					...(pag.total_available !== undefined
						? { total_available: pag.total_available }
						: {}),
					completeness: pag.completeness,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = (err as { status?: number }).status || 500;
				return {
					__api_error: true,
					status,
					message,
					data: (err as { data?: unknown }).data,
				};
			}
		},
	};
}
