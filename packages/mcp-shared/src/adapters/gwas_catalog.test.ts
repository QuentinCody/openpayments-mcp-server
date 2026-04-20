import { describe, expect, it } from "vitest";
import { gwasAssociations, gwasGet } from "./gwas_catalog.js";

describe("gwas_catalog adapter", () => {
	it("gwasAssociations builds /v2/associations URL with efoTrait", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ _embedded: { associations: [] } }), { status: 200 });
		};
		await gwasAssociations({ efoTrait: "EFO_0001360", size: 50 }, { fetchImpl: f });
		expect(captured[0]).toContain("/v2/associations");
		expect(captured[0]).toContain("efoTrait=EFO_0001360");
		expect(captured[0]).toContain("size=50");
	});

	it("gwasGet forwards arbitrary paths", async () => {
		const f: typeof fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
		const out = await gwasGet<{ ok: true }>("/v2/studies/GCST123", {}, { fetchImpl: f });
		expect(out.ok).toBe(true);
	});
});
