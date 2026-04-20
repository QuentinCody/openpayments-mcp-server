import { describe, expect, it } from "vitest";
import { hpaGene, hpaSearch } from "./hpa.js";

describe("hpa adapter", () => {
	it("hpaGene fetches /{ensembl_id}.json", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ Ensembl: "ENSG00000141510" }), { status: 200 });
		};
		await hpaGene("ENSG00000141510", { fetchImpl: f });
		expect(captured[0]).toContain("/ENSG00000141510.json");
	});

	it("hpaSearch uses /api/search_download.php with format=json", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify([]), { status: 200 });
		};
		await hpaSearch("TCF7L2", { fetchImpl: f });
		expect(captured[0]).toContain("search_download.php");
		expect(captured[0]).toContain("format=json");
	});
});
