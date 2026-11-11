import { countReturnedRecords } from "../record-count";
import {
	buildCodeModeCitationMeta,
	type CodeModeCitationContext,
	stagedPayloadHash,
} from "./citation-meta";
import { markDidNotComplete } from "./program-error";
import {
	type CodeModeResponse,
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
		recordCount: typeof staged.returned_record_count === "number" && Number.isSafeInteger(staged.returned_record_count) && staged.returned_record_count >= 0 ? staged.returned_record_count : undefined,
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
		slim.recordCount,
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
		countReturnedRecords(raw),
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
): Promise<CodeModeResponse> {
	const retrievedAt = new Date().toISOString();
	if (result.error) return errorResult(result, context, retrievedAt);
	const response = await successResult(result, context, retrievedAt);
	const raw = result.result;
	if (raw && typeof raw === "object" && Reflect.get(raw, "__api_error") === true) {
		return { ...response, isError: true,
			content: [{ type: "text", text: `API error: ${String(Reflect.get(raw, "message") ?? "request failed").slice(0, 1000)}` }],
			structuredContent: { ...response.structuredContent, success: false } };
	}
	return response;
}
