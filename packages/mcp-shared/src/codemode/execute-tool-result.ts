import { inferUpstreamTotal } from "../completeness";
import {
	buildCodeModeCitationMeta,
	type CodeModeCitationContext,
	stagedPayloadHash,
} from "./citation-meta";
import { markDidNotComplete } from "./program-error";
import {
	createCodeModeError,
	createCodeModeResponse,
	ErrorCodes,
} from "./response";

export interface RestExecutorResult {
	result?: unknown;
	error?: string;
	logs?: string[];
	__stagedResults?: Array<Record<string, unknown>>;
}

function countRecords(data: unknown, totalRows: unknown): number | undefined {
	if (typeof totalRows === "number") return totalRows;
	if (Array.isArray(data)) return data.length;
	// Envelope shapes ({total, hits:[]}, {gene, curations:[]}) previously returned
	// undefined here, so an empty result could never be classified as a negative
	// and was signed as negative_result:false. Read the upstream's own total when
	// it exposes one, else fall back to the single records array in the envelope.
	const upstream = inferUpstreamTotal(data);
	if (upstream !== undefined) return upstream;
	return countSoleRecordsArray(data);
}

/**
 * Length of the one array in a shallow envelope, when there is exactly one.
 *
 * Deliberately conservative: with zero or several candidate arrays the shape is
 * ambiguous, and guessing wrong would mislabel a populated result as empty.
 */
function countSoleRecordsArray(data: unknown): number | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const arrays = Object.values(data as Record<string, unknown>).filter(
		Array.isArray,
	);
	return arrays.length === 1 ? (arrays[0] as unknown[]).length : undefined;
}

function slimStaged(staged: Record<string, unknown>) {
	const { schema: _schema, _staging: staging, ...data } = staged;
	return {
		data,
		dataAccessId:
			typeof staged.data_access_id === "string"
				? staged.data_access_id
				: undefined,
		tablesCreated: staged.tables_created,
		totalRows: staged.total_rows,
		payloadHash: stagedPayloadHash(staging),
		completeness:
			staging !== null && typeof staging === "object" && !Array.isArray(staging)
				? Reflect.get(staging, "completeness")
				: undefined,
	};
}

async function stagedResult(
	staged: Record<string, unknown>,
	logs: string[] | undefined,
	context: CodeModeCitationContext | undefined,
	retrievedAt: string,
) {
	const slim = slimStaged(staged);
	const citation = await buildCodeModeCitationMeta(
		context,
		slim.data,
		typeof slim.totalRows === "number" ? slim.totalRows : undefined,
		slim.dataAccessId,
		retrievedAt,
		slim.payloadHash,
	);
	return createCodeModeResponse(slim.data, {
		meta: {
			staged: true,
			data_access_id: slim.dataAccessId,
			tables_created: slim.tablesCreated,
			total_rows: slim.totalRows,
			payload_hash: slim.payloadHash,
			...(slim.completeness ? { completeness: slim.completeness } : {}),
			...citation,
			...(logs?.length ? { console_output: logs.join("\n") } : {}),
			executed_at: retrievedAt,
		},
	});
}

async function errorResult(
	result: RestExecutorResult,
	context: CodeModeCitationContext | undefined,
	retrievedAt: string,
) {
	// Recovery exists for one narrow case: `api.get` auto-staged, so the program
	// received an envelope where it expected rows and threw on the first array
	// access. Dropping the staged evidence there would discard a completed fetch.
	// It fires for ANY error though, so the failure has to travel with it.
	const lastStaged = result.__stagedResults?.at(-1);
	if (lastStaged) {
		const recovered = await stagedResult(
			lastStaged,
			result.logs,
			context,
			retrievedAt,
		);
		return markDidNotComplete(recovered, result.error, lastStaged.data_access_id);
	}
	const logOutput = result.logs?.length
		? `\n\nConsole output:\n${result.logs.join("\n")}`
		: "";
	return createCodeModeError(
		ErrorCodes.API_ERROR,
		`${result.error}${logOutput}`,
	);
}

async function successResult(
	result: RestExecutorResult,
	context: CodeModeCitationContext | undefined,
	retrievedAt: string,
) {
	const raw = result.result;
	const isStaged =
		raw !== null &&
		typeof raw === "object" &&
		!Array.isArray(raw) &&
		Reflect.get(raw, "__staged") === true;
	if (isStaged) {
		return stagedResult(
			raw as Record<string, unknown>,
			result.logs,
			context,
			retrievedAt,
		);
	}
	const citation = await buildCodeModeCitationMeta(
		context,
		raw,
		countRecords(raw, undefined),
		undefined,
		retrievedAt,
	);
	return createCodeModeResponse(raw, {
		meta: {
			...citation,
			...(result.logs?.length
				? { console_output: result.logs.join("\n") }
				: {}),
			executed_at: retrievedAt,
		},
	});
}

export async function handleRestExecutorResult(
	result: RestExecutorResult,
	context?: CodeModeCitationContext,
) {
	const retrievedAt = new Date().toISOString();
	return result.error
		? errorResult(result, context, retrievedAt)
		: successResult(result, context, retrievedAt);
}
