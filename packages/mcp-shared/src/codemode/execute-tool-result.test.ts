import { describe, expect, it } from "vitest";
import { handleRestExecutorResult } from "./execute-tool-result";

const context = {
	source: { id: "example", name: "Example" },
	server: "example",
	tool: "example_execute",
	query: "return api.get('/records')",
};

describe("REST execute result handling", () => {
	it("cites inline response data", async () => {
		const response = await handleRestExecutorResult(
			{ result: [{ id: 1 }] },
			context,
		);
		expect(response.structuredContent).toMatchObject({
			data: [{ id: 1 }],
			_meta: { citation: { result_scope: "structured_content:data" } },
		});
	});

	it("binds an auto-staged response to its preserved full payload", async () => {
		const digest = "b".repeat(64);
		const response = await handleRestExecutorResult(
			{
				result: {
					__staged: true,
					data_access_id: "rest_full_1",
					tables_created: ["records"],
					total_rows: 50,
					_staging: { payload_hash: `sha256:${digest}` },
					schema: { large: true },
				},
			},
			context,
		);
		expect(response.structuredContent).toMatchObject({
			data: { data_access_id: "rest_full_1" },
			_meta: {
				payload_hash: `sha256:${digest}`,
				citation: {
					result_scope: "staged:full_result",
					result_hash: digest,
				},
			},
		});
	});

	it("recovers a staged handle after invalid array access", async () => {
		const digest = "c".repeat(64);
		const response = await handleRestExecutorResult(
			{
				error: "slice is not a function",
				logs: ["staged"],
				__stagedResults: [
					{
						__staged: true,
						data_access_id: "rest_full_2",
						_staging: { payload_hash: `sha256:${digest}` },
					},
				],
			},
			context,
		);
		expect(response.structuredContent).toMatchObject({
			_meta: {
				staged: true,
				console_output: "staged",
				citation: { result_hash: digest },
			},
		});
	});

	it("returns a contract error for ordinary executor failures", async () => {
		const response = await handleRestExecutorResult({ error: "upstream failed" });
		expect(response).toMatchObject({
			isError: true,
			structuredContent: { success: false },
		});
	});

	// The recovery above used to be silent: ANY throw after ANY staging came back
	// as a clean success carrying the last staged API response, with a citation
	// vouching for bytes the program never returned. Verified live before the fix
	// — `throw new Error("MARKER")` produced success:true and the marker appeared
	// nowhere in the response.
	it("never reports a crashed program as a completed one", async () => {
		const response = await handleRestExecutorResult(
			{
				error: "DELIBERATE_CRASH_MARKER",
				__stagedResults: [
					{ __staged: true, data_access_id: "rest_full_3", total_rows: 2 },
				],
			},
			context,
		);
		const sc = response.structuredContent as Record<string, unknown>;

		expect(sc.disposition).toBe("partial");
		expect(sc.program_error).toMatchObject({
			code: "PROGRAM_DID_NOT_COMPLETE",
			message: "DELIBERATE_CRASH_MARKER",
			recovered: "last_staged_result",
		});
		// The failure must be legible to a text-only reader too.
		expect(response.content[0].text).toContain("PROGRAM DID NOT COMPLETE");
		expect(response.content[0].text).toContain("DELIBERATE_CRASH_MARKER");
	});

	it("still hands back the staged evidence it recovered", async () => {
		// Recovery is the point — the fetch really did complete before the throw.
		const response = await handleRestExecutorResult(
			{
				error: "boom",
				__stagedResults: [
					{ __staged: true, data_access_id: "rest_full_4", total_rows: 7 },
				],
			},
			context,
		);
		expect(response.structuredContent).toMatchObject({
			data: { data_access_id: "rest_full_4" },
			_meta: { staged: true, data_access_id: "rest_full_4", total_rows: 7 },
		});
	});

	it("marks a completed program as anything but partial", async () => {
		// Guard against the fix over-reaching: a clean run must stay clean.
		const response = await handleRestExecutorResult(
			{ result: [{ id: 1 }] },
			context,
		);
		const sc = response.structuredContent as Record<string, unknown>;
		expect(sc.disposition).toBeUndefined();
		expect(sc.program_error).toBeUndefined();
	});
});
