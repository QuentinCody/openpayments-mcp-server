import { describe, expect, it } from "vitest";
import {
	describeDuoCode,
	DUO_TERMS,
	duoCodeForShorthand,
	duoObligations,
	isDuoCurie,
	isUsableDuoCode,
	normalizeDuoCodes,
	summariseDuoCodes,
} from "./duo";

describe("DUO_TERMS", () => {
	it("keys every term by a well-formed CURIE", () => {
		for (const code of Object.keys(DUO_TERMS)) {
			expect(isDuoCurie(code)).toBe(true);
		}
	});

	it("pins the shorthands that are easy to confuse", () => {
		// NPUNCU and NPU are distinct codes with distinct meanings.
		expect(DUO_TERMS["DUO:0000018"].shorthand).toBe("NPUNCU");
		expect(DUO_TERMS["DUO:0000045"].shorthand).toBe("NPU");
		expect(DUO_TERMS["DUO:0000046"].shorthand).toBe("NCU");
	});

	it("marks the two root classes as roots and everything else as usable", () => {
		expect(DUO_TERMS["DUO:0000001"].kind).toBe("root");
		expect(DUO_TERMS["DUO:0000017"].kind).toBe("root");
		expect(DUO_TERMS["DUO:0000042"].kind).toBe("permission");
		expect(DUO_TERMS["DUO:0000019"].kind).toBe("modifier");
	});

	it("gives every non-root term a shorthand", () => {
		for (const [code, term] of Object.entries(DUO_TERMS)) {
			if (term.kind === "root") continue;
			expect(term.shorthand, `${code} should have a shorthand`).toBeTruthy();
		}
	});
});

describe("isDuoCurie / isUsableDuoCode", () => {
	it("accepts a well-formed CURIE", () => {
		expect(isDuoCurie("DUO:0000042")).toBe(true);
	});

	it("rejects malformed values", () => {
		expect(isDuoCurie("DUO:42")).toBe(false);
		expect(isDuoCurie("duo:0000042")).toBe(false);
		expect(isDuoCurie("0000042")).toBe(false);
		expect(isDuoCurie(42)).toBe(false);
		expect(isDuoCurie(null)).toBe(false);
	});

	it("treats a syntactically valid but unknown code as unusable", () => {
		expect(isDuoCurie("DUO:9999999")).toBe(true);
		expect(isUsableDuoCode("DUO:9999999")).toBe(false);
	});

	it("treats the root classes as unusable annotations", () => {
		expect(isUsableDuoCode("DUO:0000001")).toBe(false);
		expect(isUsableDuoCode("DUO:0000017")).toBe(false);
	});
});

describe("duoCodeForShorthand", () => {
	it("resolves a shorthand case-insensitively", () => {
		expect(duoCodeForShorthand("gru")).toBe("DUO:0000042");
		expect(duoCodeForShorthand(" NCU ")).toBe("DUO:0000046");
	});

	it("returns undefined for an unknown shorthand", () => {
		expect(duoCodeForShorthand("NOPE")).toBeUndefined();
	});
});

describe("normalizeDuoCodes", () => {
	it("drops unknown, root and malformed codes", () => {
		expect(
			normalizeDuoCodes([
				"DUO:0000042",
				"DUO:0000001",
				"DUO:9999999",
				"garbage",
				null,
			]),
		).toEqual(["DUO:0000042"]);
	});

	it("de-duplicates and orders so two servers agree byte-for-byte", () => {
		expect(normalizeDuoCodes(["DUO:0000046", "DUO:0000042", "DUO:0000046"])).toEqual([
			"DUO:0000042",
			"DUO:0000046",
		]);
	});

	it("is idempotent", () => {
		const input = ["DUO:0000046", "DUO:0000042", "DUO:0000001", "junk"];
		const once = normalizeDuoCodes(input);
		expect(normalizeDuoCodes(once)).toEqual(once);
	});
});

describe("duoObligations", () => {
	it("reports no obligations for unrestricted data", () => {
		const obligations = duoObligations(["DUO:0000004"]);
		expect(obligations.hasRestrictions).toBe(false);
		expect(obligations.nonCommercialOnly).toBe(false);
	});

	it("flags non-commercial use from NCU", () => {
		expect(duoObligations(["DUO:0000046"]).nonCommercialOnly).toBe(true);
	});

	it("flags both non-commercial and not-for-profit from the combined NPUNCU code", () => {
		const obligations = duoObligations(["DUO:0000018"]);
		expect(obligations.nonCommercialOnly).toBe(true);
		expect(obligations.notForProfitOnly).toBe(true);
	});

	it("flags not-for-profit alone from NPU", () => {
		const obligations = duoObligations(["DUO:0000045"]);
		expect(obligations.notForProfitOnly).toBe(true);
		expect(obligations.nonCommercialOnly).toBe(false);
	});

	it("flags each dedicated obligation from its own code", () => {
		expect(duoObligations(["DUO:0000019"]).publicationRequired).toBe(true);
		expect(duoObligations(["DUO:0000024"]).publicationMoratorium).toBe(true);
		expect(duoObligations(["DUO:0000021"]).ethicsApprovalRequired).toBe(true);
		expect(duoObligations(["DUO:0000020"]).collaborationRequired).toBe(true);
		expect(duoObligations(["DUO:0000022"]).geographicRestriction).toBe(true);
		expect(duoObligations(["DUO:0000029"]).returnToResource).toBe(true);
	});

	it("reports hasRestrictions for a modifier without a dedicated flag", () => {
		expect(duoObligations(["DUO:0000025"]).hasRestrictions).toBe(true);
	});

	it("never grants permission from an unrecognised code", () => {
		const obligations = duoObligations(["DUO:9999999"]);
		expect(obligations.hasRestrictions).toBe(false);
		expect(obligations.nonCommercialOnly).toBe(false);
	});
});

describe("summariseDuoCodes", () => {
	it("renders shorthand and label for each code", () => {
		expect(summariseDuoCodes(["DUO:0000042"])).toBe("GRU (general research use)");
	});

	it("returns undefined when nothing usable was supplied", () => {
		expect(summariseDuoCodes([])).toBeUndefined();
		expect(summariseDuoCodes(["DUO:0000001"])).toBeUndefined();
	});
});

describe("describeDuoCode", () => {
	it("returns the term for a known code", () => {
		expect(describeDuoCode("DUO:0000042")?.label).toBe("general research use");
	});

	it("returns undefined for an unknown code", () => {
		expect(describeDuoCode("DUO:9999999")).toBeUndefined();
	});
});
