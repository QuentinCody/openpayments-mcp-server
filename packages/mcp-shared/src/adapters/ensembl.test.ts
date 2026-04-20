import { describe, expect, it } from "vitest";
import { ensemblGet, ensemblPost } from "./ensembl.js";

function stub(json: unknown): typeof fetch {
	return (async () => new Response(JSON.stringify(json), { status: 200 })) as typeof fetch;
}

describe("ensembl adapter", () => {
	it("ensemblGet resolves JSON from GRCh38 by default", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ id: "rs7903146", mappings: [] }), { status: 200 });
		};
		const out = await ensemblGet<{ id: string }>("/variation/human/rs7903146", { fetchImpl: f });
		expect(out.id).toBe("rs7903146");
		expect(captured[0]).toContain("rest.ensembl.org");
	});

	it("ensemblPost sends JSON body", async () => {
		const out = await ensemblPost<unknown>("/vep/human/region", { variants: ["1 100 . A G" ] }, { fetchImpl: stub({ ok: true }) });
		expect(out).toEqual({ ok: true });
	});
});
