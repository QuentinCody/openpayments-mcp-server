import { describe, expect, it } from "vitest";
import { genebassGeneBurden } from "./genebass.js";

describe("genebass adapter", () => {
	it("hits gene_burden_phewas with expected query params", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ ok: true, associations: [] }), { status: 200 });
		};
		const result = await genebassGeneBurden("ENSG00000147883", "pLoF", { fetchImpl: f });
		expect(captured[0]).toContain("gene_id=ENSG00000147883");
		expect(captured[0]).toContain("burden_set=pLoF");
		expect(result).toMatchObject({ ok: true });
	});
});
