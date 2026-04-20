import { describe, expect, it } from "vitest";
import { gtexEqtlsByVariants, gtexGet } from "./gtex.js";

describe("gtex adapter", () => {
	it("gtexGet passes params as query string", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		};
		await gtexGet("/variant/variantById", { variantId: "chr10_114758349_C_T_b38" }, { fetchImpl: f });
		expect(captured[0]).toContain("variantId=chr10_114758349_C_T_b38");
	});

	it("gtexEqtlsByVariants batches variantId params", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		};
		await gtexEqtlsByVariants(["v1", "v2"], { fetchImpl: f });
		expect(captured[0]).toContain("variantId=v1");
		expect(captured[0]).toContain("variantId=v2");
	});
});
