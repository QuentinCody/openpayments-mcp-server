/**
 * Result handling for the GraphQL execute tool — turns a DynamicWorkerExecutor
 * result into an MCP code-mode response, attaching staging metadata and an
 * optional verifiable `_meta.citation`. Extracted from graphql-execute-tool.ts
 * (which hit the line cap); shared with the REST execute-tool pattern.
 */

import {
	buildCodeModeCitationMeta,
	type CodeModeCitationContext,
	stagedPayloadHash,
} from "./citation-meta";
import {
	createCodeModeError,
	createCodeModeResponse,
	ErrorCodes,
} from "./response";

/** Provenance context threaded from the factory options into result handling. */
export type CitationCtx = CodeModeCitationContext;

/** The raw shape returned by DynamicWorkerExecutor.execute(). */
interface ExecutorResult {
	result?: unknown;
	error?: string;
	logs?: string[];
	__stagedResults?: Array<Record<string, unknown>>;
}

/** Records returned, for the citation: staged total_rows, else array length. */
function countRecords(data: unknown, totalRows: unknown): number | undefined {
	if (typeof totalRows === "number") return totalRows;
	if (Array.isArray(data)) return data.length;
	return undefined;
}

/** Strip the large `schema`/`_staging` fields (available via get_schema) from a
 *  staged object and surface its staging-metadata fields. */
function slimStaged(obj: Record<string, unknown>): {
	slim: Record<string, unknown>;
	dataAccessId: string | undefined;
	tablesCreated: unknown;
	totalRows: unknown;
	payloadHash: unknown;
} {
	const { schema: _s, _staging: _st, ...slim } = obj;
	return {
		slim,
		dataAccessId: obj.data_access_id as string | undefined,
		tablesCreated: obj.tables_created,
		totalRows: obj.total_rows,
		payloadHash: stagedPayloadHash(_st),
	};
}

/** The isolate reported an error. If it was a staged-array access, recover the
 *  staging metadata; otherwise return a plain code-mode error. */
async function errorResult(
	result: ExecutorResult,
	prov: CitationCtx | undefined,
	retrievedAt: string,
) {
	if (result.__stagedResults?.length) {
		const staged = result.__stagedResults[result.__stagedResults.length - 1];
		const { slim, dataAccessId, tablesCreated, totalRows, payloadHash } =
			slimStaged(staged);
		const logOutput = result.logs?.length ? result.logs.join("\n") : undefined;
		const cite = await buildCodeModeCitationMeta(
			prov,
			slim,
			totalRows as number | undefined,
			dataAccessId,
			retrievedAt,
			payloadHash,
		);
		return createCodeModeResponse(slim, {
			meta: {
				staged: true,
				data_access_id: dataAccessId,
				tables_created: tablesCreated,
				total_rows: totalRows,
				...(payloadHash ? { payload_hash: payloadHash } : {}),
				...cite,
				...(logOutput ? { console_output: logOutput } : {}),
				executed_at: retrievedAt,
			},
		});
	}

	const logOutput = result.logs?.length
		? `\n\nConsole output:\n${result.logs.join("\n")}`
		: "";
	return createCodeModeError(
		ErrorCodes.API_ERROR,
		`${result.error}${logOutput}`,
	);
}

/** The isolate succeeded. Detect an auto-staged return, slim it, and attach the
 *  optional citation + console output. */
async function successResult(
	result: ExecutorResult,
	prov: CitationCtx | undefined,
	retrievedAt: string,
) {
	const logOutput = result.logs?.length ? result.logs.join("\n") : undefined;
	const raw = result.result;

	const isStaged =
		raw !== null &&
		typeof raw === "object" &&
		!Array.isArray(raw) &&
		"__staged" in raw &&
		(raw as { __staged: unknown }).__staged === true;

	let responseData: unknown = raw;
	const stagingMeta: Record<string, unknown> = {};

	if (isStaged) {
		const { slim, dataAccessId, tablesCreated, totalRows, payloadHash } = slimStaged(
			raw as Record<string, unknown>,
		);
		stagingMeta.staged = true;
		stagingMeta.data_access_id = dataAccessId;
		stagingMeta.tables_created = tablesCreated;
		stagingMeta.total_rows = totalRows;
		stagingMeta.payload_hash = payloadHash;
		responseData = slim;
	}

	const cite = await buildCodeModeCitationMeta(
		prov,
		responseData,
		countRecords(responseData, stagingMeta.total_rows),
		stagingMeta.data_access_id as string | undefined,
		retrievedAt,
		stagingMeta.payload_hash,
	);

	return createCodeModeResponse(responseData, {
		meta: {
			...stagingMeta,
			...cite,
			...(logOutput ? { console_output: logOutput } : {}),
			executed_at: retrievedAt,
		},
	});
}

/** Turn an executor result into an MCP code-mode response (success or error). */
export async function handleExecutorResult(
	result: ExecutorResult,
	prov?: CitationCtx,
) {
	const retrievedAt = new Date().toISOString();
	return result.error
		? errorResult(result, prov, retrievedAt)
		: successResult(result, prov, retrievedAt);
}
