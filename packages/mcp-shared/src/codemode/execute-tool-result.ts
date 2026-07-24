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

export interface RestExecutorResult {
	result?: unknown;
	error?: string;
	logs?: string[];
	__stagedResults?: Array<Record<string, unknown>>;
}

function countRecords(data: unknown, totalRows: unknown): number | undefined {
	if (typeof totalRows === "number") return totalRows;
	return Array.isArray(data) ? data.length : undefined;
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
	const lastStaged = result.__stagedResults?.at(-1);
	if (lastStaged) {
		return stagedResult(lastStaged, result.logs, context, retrievedAt);
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
