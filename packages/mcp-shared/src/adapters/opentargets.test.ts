import { describe, expect, it } from "vitest";
import { opentargetsGraphql } from "./opentargets.js";

describe("opentargets adapter", () => {
	it("posts a GraphQL query and returns the response data", async () => {
		const f: typeof fetch = async () =>
			new Response(JSON.stringify({ data: { search: { total: 1 } } }), { status: 200 });
		const result = await opentargetsGraphql<{ search: { total: number } }>(
			"query Q { search { total } }",
			{},
			{ fetchImpl: f },
		);
		expect(result.data?.search.total).toBe(1);
	});
});
