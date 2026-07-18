/**
 * Hidden __graphql_proxy tool — routes V8 isolate gql.query() calls
 * through the server's GraphQL fetch function.
 *
 * This tool is only callable from V8 isolates (hidden=true).
 * It executes GraphQL queries, handles errors, and auto-stages
 * large responses via stageToDoAndRespond().
 */

import { z } from "zod";
import type {
	GraphqlFetchFn,
	TrimmedIntrospection,
} from "../codemode/graphql-introspection";
import {
	formatGqlValidationErrors,
	validateGraphqlQuery,
} from "../codemode/graphql-validate";
import type { ToolContext, ToolEntry } from "../registry/types";
import { effectiveStagingThreshold } from "../staging/single-record";
import { shouldStage, stageToDoAndRespond } from "../staging/utils";
import { buildStageOptions } from "./api-proxy";
import { isOversized, TRANSPORT_LIMIT } from "./passthrough-limits";
import { buildStagedEnvelope } from "./staging-envelope";

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/** What a GraphQL `errors` array means for the response that carries it. */
export interface GraphqlErrorInfo {
	/** Flattened `errors[].message` strings. */
	messages: string[];
	/** True when `data` came back ALONGSIDE the errors — a partial result. */
	partial: boolean;
}

/**
 * Inspect a raw GraphQL response body for an `errors` array.
 *
 * GraphQL answers a rejected query with **HTTP 200 + `{errors:[…]}`**. A
 * hand-built passthrough that returns that body unexamined reports
 * `structuredContent.success: true` — and, where the server declares a `source`,
 * stamps a `_meta.citation` on it. `isErrorResult()` only inspects
 * `isError`/`success:false`, so such a tool **cannot fail**: it goes green
 * against a dead API and hands the caller an error payload as an answer.
 * Observed across rcsb-pdb, pharos, zincbind, dgidb, nci-gdc and nci-pdc.
 *
 * Semantics mirror the isolate-side proxy below (`__gql_error` vs `__errors`):
 * errors WITHOUT data is a failure; errors ALONGSIDE data is a partial result
 * that must stay visible but must not be reported as a clean success.
 *
 * @returns null when the body carries no GraphQL errors.
 */
export function inspectGraphqlErrors(result: unknown): GraphqlErrorInfo | null {
	if (!result || typeof result !== "object") return null;
	const body = result as { errors?: unknown; data?: unknown };
	if (!Array.isArray(body.errors) || body.errors.length === 0) return null;
	const messages = body.errors.map((e) => {
		if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
		return String(e);
	});
	return { messages, partial: body.data !== undefined && body.data !== null };
}

export interface GraphqlProxyToolOptions {
	/** Function to execute GraphQL queries on the host */
	gqlFetch: GraphqlFetchFn;
	/** DO namespace for auto-staging large responses */
	doNamespace?: unknown;
	/** Prefix for data access IDs (e.g., "pharos") */
	stagingPrefix: string;
	/** Byte threshold for auto-staging (default from shouldStage) */
	stagingThreshold?: number;
	/** WorkspaceDO namespace — when set and `ctx.workspace` is present, auto-staging routes there (ADR-006 Phase 0). */
	workspaceNamespace?: unknown;
	/**
	 * Provider for the cached introspection schema. When it returns a schema, the
	 * proxy runs a conservative pre-flight {@link validateGraphqlQuery} BEFORE
	 * `gqlFetch` and fails locally on confident errors (T1.2) — zero upstream
	 * round-trip on a hallucinated field/arg. Returns `undefined` until
	 * introspection is fetched; in that window queries pass straight through.
	 */
	getIntrospection?: () => TrimmedIntrospection | undefined;
}

interface StagingConfig {
	doNamespace: unknown;
	prefix: string;
	threshold: number | undefined;
	workspaceNamespace?: unknown;
}

/**
 * Try to auto-stage a large response into the DO.
 * Returns the staging envelope if staged, or undefined if not applicable.
 *
 * When `ctx.workspace` is set AND the server wired a `workspaceNamespace`,
 * staging is routed into the shared WorkspaceDO via {@link buildStageOptions}
 * (ADR-006 Phase 0). Otherwise the per-server DO path is used — unchanged. The
 * envelope (columns T3.3, filter_warning T1.3, preserved scalars) is built by
 * the shared {@link buildStagedEnvelope}, identical to the REST proxy. A SINGLE
 * record gets a raised threshold (T10.1) so a one-entity lookup stays inline.
 */
async function tryAutoStage(
	resultData: unknown,
	responseBytes: number,
	config: StagingConfig,
	ctx: ToolContext | undefined,
): Promise<Record<string, unknown> | undefined> {
	if (
		!config.doNamespace ||
		!shouldStage(
			responseBytes,
			effectiveStagingThreshold(resultData, config.threshold),
		)
	) {
		return undefined;
	}

	const staged = await stageToDoAndRespond(
		resultData,
		config.doNamespace as Parameters<typeof stageToDoAndRespond>[1],
		config.prefix,
		undefined,
		undefined,
		config.prefix,
		ctx?.sessionId,
		buildStageOptions(ctx, config.workspaceNamespace, config.prefix),
	);
	return buildStagedEnvelope({
		staged,
		responseBytes,
		originalData: resultData,
	});
}

/**
 * #5/#6 — a NOT-staged inline envelope (data + any partial `__errors`) over the
 * transport limit is silently dropped by MCP Streamable HTTP. Return a small
 * `__gql_error` instead of the doomed payload, or `undefined` to let `output`
 * through. Sizing the whole `output` catches #6: an `errors[]` attached AFTER
 * `data` can push the combined envelope over even when `data` alone fit.
 */
function oversizedGqlError(
	output: unknown,
	staged: unknown,
	errorCount: number,
): Record<string, unknown> | undefined {
	if (staged || !isOversized(output)) return undefined;
	const suppressed =
		errorCount > 0 ? ` (${errorCount} partial error(s) suppressed.)` : "";
	return {
		__gql_error: true,
		incomplete: true,
		code: "RESPONSE_TOO_LARGE",
		message: `GraphQL response exceeds the ${TRANSPORT_LIMIT}-byte inline limit and no staging DO is configured; narrow the query or select fewer fields.${suppressed}`,
	};
}

/**
 * Execute a GraphQL query and return the result, staging if needed.
 */
async function executeAndMaybeStage(
	gqlFetch: GraphqlFetchFn,
	query: string,
	variables: Record<string, unknown> | undefined,
	staging: StagingConfig,
	ctx: ToolContext | undefined,
): Promise<unknown> {
	const response = await gqlFetch(query, variables);
	// An empty errors[] is NOT an error (#10): only a non-empty array signals one.
	const errors = Array.isArray(response.errors) ? response.errors : [];

	// GraphQL errors without data — return error
	if (errors.length > 0 && !response.data) {
		const messages = errors.map((e) => e.message).join("; ");
		return { __gql_error: true, message: messages, errors };
	}

	// Always return response.data directly for consistent shape.
	// If there are partial errors alongside data, attach them as a
	// non-enumerable __errors property so they don't pollute staging
	// but isolate code can still inspect them via result.__errors.
	const resultData = response.data ?? {};

	const responseBytes = JSON.stringify(resultData).length;
	const staged = await tryAutoStage(resultData, responseBytes, staging, ctx);
	const output = staged ?? resultData;

	// Attach partial errors if present (errors-only case is handled above)
	if (errors.length > 0 && output && typeof output === "object") {
		(output as Record<string, unknown>).__errors = errors;
	}

	const tooBig = oversizedGqlError(output, staged, errors.length);
	if (tooBig) return tooBig;

	return output;
}

/**
 * Pre-flight validate a query against cached introspection (T1.2). Returns a
 * structured `__gql_error` envelope to short-circuit on confident errors, or
 * `undefined` to let the query proceed to `gqlFetch`.
 */
function preflightValidate(
	query: string,
	getIntrospection: (() => TrimmedIntrospection | undefined) | undefined,
): Record<string, unknown> | undefined {
	const introspection = getIntrospection?.();
	if (!introspection) return undefined;
	const verdict = validateGraphqlQuery(query, introspection);
	if (!verdict.checked || verdict.errors.length === 0) return undefined;
	return {
		__gql_error: true,
		code: "QUERY_VALIDATION",
		preflight: true,
		message: formatGqlValidationErrors(verdict.errors),
		errors: verdict.errors,
	};
}

/**
 * Build the handler function for the __graphql_proxy tool.
 */
function buildHandler(
	gqlFetch: GraphqlFetchFn,
	staging: StagingConfig,
	getIntrospection: (() => TrimmedIntrospection | undefined) | undefined,
): (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> {
	return async (input, ctx) => {
		const query = String(input.query || "");
		const variables = input.variables as Record<string, unknown> | undefined;

		if (!query) {
			return { __gql_error: true, message: "query is required", errors: [] };
		}

		// T1.2 — fail locally on a confidently-invalid query, zero upstream call.
		const preflight = preflightValidate(query, getIntrospection);
		if (preflight) return preflight;

		try {
			return await executeAndMaybeStage(
				gqlFetch,
				query,
				variables,
				staging,
				ctx,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { __gql_error: true, message, errors: [{ message }] };
		}
	};
}

/**
 * Create the hidden __graphql_proxy tool entry.
 */
export function createGraphqlProxyTool(
	options: GraphqlProxyToolOptions,
): ToolEntry {
	const staging: StagingConfig = {
		doNamespace: options.doNamespace,
		prefix: options.stagingPrefix,
		threshold: options.stagingThreshold,
		workspaceNamespace: options.workspaceNamespace,
	};

	return {
		name: "__graphql_proxy",
		description:
			"Route GraphQL queries from V8 isolate through server fetch layer. Internal only.",
		hidden: true,
		schema: {
			query: z.string(),
			variables: z.record(z.string(), z.unknown()).optional(),
		},
		handler: buildHandler(options.gqlFetch, staging, options.getIntrospection),
	};
}
