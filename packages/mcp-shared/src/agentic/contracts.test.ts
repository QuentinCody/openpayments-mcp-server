import { describe, expect, it } from "vitest";
import {
	classifyExternalAccessFailure,
	evaluateValidation,
	type ValidationRecord,
} from "./contracts";
import {
	assertInlineTransportSafe,
	buildLosslessReference,
} from "./lossless";

const research: ValidationRecord = {
	tier: "research",
	intended_uses: ["research"],
	prohibited_uses: ["clinical"],
	required_context: ["assembly", "population"],
};

describe("agentic validation contracts", () => {
	it("fails closed on consequence tier and missing context", () => {
		const decision = evaluateValidation(research, "publication", {
			assembly: "GRCh38",
		});
		expect(decision.allowed).toBe(false);
		expect(decision.missing_context).toEqual(["population"]);
		expect(decision.issues.join(" ")).toContain("benchmarked");
	});

	it("separates unavailable credentials from implementation failures", () => {
		expect(classifyExternalAccessFailure("HTTP 401 API key required")).toBe(true);
		expect(classifyExternalAccessFailure("unexpected response schema")).toBe(false);
	});
});

describe("lossless transport contract", () => {
	it("rejects oversized inline evidence without a durable reference", () => {
		expect(() => assertInlineTransportSafe({ rows: ["x".repeat(110_000)] })).toThrow(
			/LOSSLESS_STAGING_REQUIRED/,
		);
	});

	it("accepts a hash-addressed durable reference", async () => {
		const payload = { rows: ["x".repeat(110_000)] };
		const ref = await buildLosslessReference({
			storage: "workspace",
			handle: "ws:test",
			payload,
		});
		expect(() => assertInlineTransportSafe(payload, ref)).not.toThrow();
		expect(ref.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

