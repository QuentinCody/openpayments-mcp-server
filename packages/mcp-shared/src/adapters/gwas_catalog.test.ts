import { describe, expect, it } from "vitest";
import { gwasAssociations, gwasGet } from "./gwas_catalog.js";

describe("gwas_catalog adapter", () => {
	it("maps the historical identifier argument to the v2 identifier filter", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ _embedded: { associations: [] } }), {
				status: 200,
			});
		};
		await gwasAssociations(
			{ efoTrait: "EFO_0001360", size: 50 },
			{ fetchImpl: f },
		);
		expect(captured[0]).toContain("/v2/associations");
		expect(captured[0]).toContain("efo_id=EFO_0001360");
		expect(captured[0]).not.toContain("efoTrait=");
		expect(captured[0]).toContain("size=50");
	});

	it.each([
		[{ efoId: "MONDO_0004979", traitName: "ignored label", showChildTraits: false }, { efo_id: "MONDO_0004979", show_child_trait: "false" }],
		[{ traitName: "asthma & allergy", showChildTraits: true }, { efo_trait: "asthma & allergy", show_child_trait: "true" }],
		[{ efoId: "EFO_0001360", efoTrait: "EFO_0001060" }, { efo_id: "EFO_0001360" }],
		[{}, {}],
	] as const)("uses documented v2 filters and preserves native pages: %j", async (params, expected) => {
		const native = { _embedded: { associations: [{ association_id: "123", p_value: 1e-9 }] }, page: { number: 2, totalPages: 5 } };
		const f: typeof fetch = async input => {
			const url = new URL(String(input));
			expect(Object.fromEntries(url.searchParams)).toEqual({ size: "17", page: "2", ...expected });
			return Response.json(native);
		};
		expect(await gwasAssociations({ ...params, size: 17, page: 2 }, { fetchImpl: f })).toEqual(native);
	});

	it("gwasGet forwards arbitrary paths", async () => {
		const f: typeof fetch = async () =>
			new Response(JSON.stringify({ ok: true }), { status: 200 });
		const out = await gwasGet<{ ok: true }>(
			"/v2/studies/GCST123",
			{},
			{ fetchImpl: f },
		);
		expect(out.ok).toBe(true);
	});
});
