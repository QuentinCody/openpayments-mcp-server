/**
 * Reporting a Code Mode program that threw.
 *
 * When `api.get` auto-stages, the program receives an envelope where it expected
 * rows and typically throws on the first array access. The executors recover the
 * staged payload rather than discard a fetch that actually completed — that part
 * is right. What was wrong is that the recovery applied to EVERY error and
 * dropped `result.error`, so an unrelated exception came back as `success: true`
 * carrying the last staged API response, with a citation vouching for bytes the
 * program never returned. A crash dressed as a clean run is the hardest kind of
 * wrong answer to catch, because nothing prompts the caller to look.
 *
 * So the evidence still travels — and now the failure travels with it.
 */

/** The disposition vocabulary lives in agentic/contracts.ts; a crashed program
 *  yielded evidence but not a result, which is exactly `partial`. */
const INCOMPLETE_DISPOSITION = "partial" as const;

export const PROGRAM_ERROR_CODE = "PROGRAM_DID_NOT_COMPLETE" as const;

export interface ProgramError {
	code: typeof PROGRAM_ERROR_CODE;
	message: string;
	/** What the attached data actually is, so it is never read as the result. */
	recovered: "last_staged_result";
}

/** Human-facing line. Leads with the failure, because that is the headline. */
export function programErrorText(
	programError: string | undefined,
	dataAccessId: unknown,
): string {
	const handle =
		typeof dataAccessId === "string" ? ` (data_access_id ${dataAccessId})` : "";
	return (
		`PROGRAM DID NOT COMPLETE: ${programError ?? "unknown error"}. ` +
		`Evidence staged before the failure is attached${handle}, but it is NOT ` +
		"the program's result — the program never produced one."
	);
}

/**
 * Stamp a recovered staged response with the failure that produced it.
 *
 * Both the machine channel (`disposition`, `program_error`) and the text block
 * are set, so neither a model reading `structuredContent` nor a person reading
 * the text can mistake this for a successful run.
 */
export function markDidNotComplete<
	R extends { structuredContent?: Record<string, unknown> },
>(
	response: R,
	programError: string | undefined,
	dataAccessId: unknown,
): Omit<R, "content" | "structuredContent"> & {
	content: Array<{ type: "text"; text: string }>;
	structuredContent: Record<string, unknown> & {
		disposition: typeof INCOMPLETE_DISPOSITION;
		program_error: ProgramError;
	};
} {
	return {
		...response,
		content: [{ type: "text", text: programErrorText(programError, dataAccessId) }],
		structuredContent: {
			...(response.structuredContent ?? {}),
			disposition: INCOMPLETE_DISPOSITION,
			program_error: {
				code: PROGRAM_ERROR_CODE,
				message: programError ?? "unknown error",
				recovered: "last_staged_result",
			},
		},
	};
}
