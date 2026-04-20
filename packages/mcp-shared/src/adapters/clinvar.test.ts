import { describe, expect, it } from "vitest";
import { clinvarEsearchByRsid, clinvarEsummary } from "./clinvar.js";

describe("clinvar adapter", () => {
	it("esummary passes comma-joined IDs", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ result: {} }), { status: 200 });
		};
		await clinvarEsummary(["12345", "67890"], { fetchImpl: f });
		expect(captured[0]).toContain("id=12345%2C67890");
	});

	it("esearch by rsid uses Variant ID filter", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 });
		};
		await clinvarEsearchByRsid("rs7903146", { fetchImpl: f });
		expect(captured[0]).toContain("rs7903146");
	});
});
