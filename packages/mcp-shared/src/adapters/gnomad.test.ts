import { describe, expect, it } from "vitest";
import { gnomadGraphql } from "./gnomad.js";

describe("gnomad adapter", () => {
	it("posts GraphQL query and returns data", async () => {
		const f: typeof fetch = async () =>
			new Response(JSON.stringify({ data: { gene: { gene_id: "ENSG00000148737" } } }), { status: 200 });
		const r = await gnomadGraphql<{ gene: { gene_id: string } }>(
			"query { gene { gene_id } }",
			{},
			{ fetchImpl: f },
		);
		expect(r.data?.gene.gene_id).toBe("ENSG00000148737");
	});
});
