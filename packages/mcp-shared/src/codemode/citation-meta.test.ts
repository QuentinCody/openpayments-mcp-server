import { describe, expect, it } from "vitest";
import { buildCodeModeCitationMeta } from "./citation-meta";

const context = {
	source: { id: "example", name: "Example" },
	server: "example",
	tool: "example_execute",
	query: "return api.get('/items')",
};

describe("Code Mode citation scopes", () => {
	it("declares the inline data scope when full bytes are transported", async () => {
		const result = await buildCodeModeCitationMeta(
			context,
			[{ id: 1 }],
			1,
			undefined,
			"2026-07-22T12:00:00.000Z",
		);
		expect(result.citation).toMatchObject({
			query_scope: "tool_argument:code",
			result_scope: "structured_content:data",
		});
	});

	it("binds staged citations to the preserved full-payload hash", async () => {
		const digest = "a".repeat(64);
		const result = await buildCodeModeCitationMeta(
			context,
			{ data_access_id: "example_1" },
			100,
			"example_1",
			"2026-07-22T12:00:00.000Z",
			`sha256:${digest}`,
		);
		expect(result.citation).toMatchObject({
			result_scope: "staged:full_result",
			result_hash: digest,
			data_access_id: "example_1",
		});
	});

	it("does not claim a full-result scope without a valid payload hash", async () => {
		const result = await buildCodeModeCitationMeta(
			context,
			{ data_access_id: "legacy_1" },
			100,
			"legacy_1",
			"2026-07-22T12:00:00.000Z",
			"missing",
		);
		expect(result.citation?.result_scope).toBe("structured_content:data");
	});
});
