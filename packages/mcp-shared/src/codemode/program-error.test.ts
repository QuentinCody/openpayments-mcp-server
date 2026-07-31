import { describe, expect, it } from "vitest";
import {
	markDidNotComplete,
	PROGRAM_ERROR_CODE,
	programErrorText,
} from "./program-error";

const recovered = {
	content: [{ type: "text" as const, text: "looks fine" }],
	structuredContent: {
		success: true,
		data: { rows: 2 },
		_meta: { staged: true, data_access_id: "civic_123" },
	},
};

describe("programErrorText", () => {
	it("leads with the failure and names the handle", () => {
		const text = programErrorText("boom", "civic_123");
		expect(text.startsWith("PROGRAM DID NOT COMPLETE: boom")).toBe(true);
		expect(text).toContain("data_access_id civic_123");
		// The attached bytes must never be mistaken for the program's output.
		expect(text).toContain("NOT the program's result");
	});

	it("degrades without a handle or a message", () => {
		expect(programErrorText(undefined, undefined)).toContain("unknown error");
		expect(programErrorText("boom", undefined)).not.toContain("data_access_id");
	});
});

describe("markDidNotComplete", () => {
	it("marks the run partial and carries the error message", () => {
		const marked = markDidNotComplete(recovered, "TypeError: x.map is not a function", "civic_123");
		expect(marked.structuredContent.disposition).toBe("partial");
		expect(marked.structuredContent.program_error).toEqual({
			code: PROGRAM_ERROR_CODE,
			message: "TypeError: x.map is not a function",
			recovered: "last_staged_result",
		});
	});

	it("keeps the recovered evidence intact", () => {
		// Recovery is the point — the staged fetch really did complete.
		const marked = markDidNotComplete(recovered, "boom", "civic_123");
		expect(marked.structuredContent.data).toEqual({ rows: 2 });
		expect(marked.structuredContent._meta).toEqual({
			staged: true,
			data_access_id: "civic_123",
		});
	});

	it("replaces the text block so no reader sees a clean run", () => {
		const marked = markDidNotComplete(recovered, "boom", "civic_123");
		expect(marked.content).toHaveLength(1);
		expect(marked.content[0].text).toContain("PROGRAM DID NOT COMPLETE");
		expect(marked.content[0].text).not.toContain("looks fine");
	});

	it("substitutes a message when the executor reported none", () => {
		// An error with no message must still read as a failure, not as success.
		const marked = markDidNotComplete(recovered, undefined, undefined);
		expect(marked.structuredContent.program_error.message).toBe("unknown error");
		expect(marked.structuredContent.disposition).toBe("partial");
	});
});
