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
});
