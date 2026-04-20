import { describe, expect, it } from "vitest";
import {
	COHORT_BUILD,
	buildKeyFor,
	buildVariantRecord,
	formatForCohort,
	liftover,
	lookupPosition,
	lookupRsid,
	parseVariant,
	parseVariantString,
	resolveRsid,
	resolveVariant,
	VariantResolutionError,
} from "./resolve.js";

function makeFetchStub(handlers: Record<string, unknown>): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		for (const [pattern, body] of Object.entries(handlers)) {
			if (url.includes(pattern)) {
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
		}
		return new Response(JSON.stringify({ error: "no_match" }), { status: 404 });
	}) as typeof fetch;
}

describe("parseVariantString", () => {
	it("parses dash-separated GRCh38 input", () => {
		expect(parseVariantString("1-12345-A-G")).toEqual({ chr: "1", pos: 12345, ref: "A", alt: "G" });
	});
	it("parses chr-prefixed colon/underscore form", () => {
		expect(parseVariantString("chr10:200_A/G")).toEqual({
			chr: "10",
			pos: 200,
			ref: "A",
			alt: "G",
		});
	});
	it("normalizes M to MT", () => {
		expect(parseVariantString("chrM-1-A-T").chr).toBe("MT");
	});
	it("rejects malformed input", () => {
		expect(() => parseVariantString("nonsense")).toThrow(/Invalid variant format/);
		expect(() => parseVariantString("")).toThrow(/empty/);
		expect(() => parseVariantString("1-foo-A-G")).toThrow(/position/);
		expect(() => parseVariantString("chrZZ-1-A-G")).toThrow(/chromosome/);
		expect(() => parseVariantString("1-1-A-1")).toThrow(/ALT allele/);
	});
	it("parseVariant alias matches parseVariantString", () => {
		expect(parseVariant("X-100-A-G")).toEqual(parseVariantString("X-100-A-G"));
	});
});

describe("buildKeyFor", () => {
	it("maps GRCh37/hg19 to grch37, otherwise grch38", () => {
		expect(buildKeyFor("GRCh37")).toBe("grch37");
		expect(buildKeyFor("hg19")).toBe("grch37");
		expect(buildKeyFor("GRCh38")).toBe("grch38");
	});
});

describe("buildVariantRecord", () => {
	it("computes canonical when ref+alt provided", () => {
		expect(buildVariantRecord("1", 12345, "A", "G").canonical).toBe("1:12345-A-G");
	});
	it("omits canonical when ref or alt missing", () => {
		expect(buildVariantRecord("1", 12345, null, "G").canonical).toBeUndefined();
	});
});

describe("formatForCohort", () => {
	it("uses canonical when present", () => {
		expect(
			formatForCohort(buildVariantRecord("1", 100, "A", "G"), "finngen"),
		).toBe("1:100-A-G");
	});
	it("constructs canonical when missing", () => {
		expect(formatForCohort({ chr: "2", pos: 5, ref: "T", alt: "C" }, "bbj")).toBe("2:5-T-C");
	});
	it("throws when ref/alt missing", () => {
		expect(() => formatForCohort({ chr: "1", pos: 1, ref: null, alt: null }, "finngen")).toThrow();
	});
});

describe("COHORT_BUILD", () => {
	it("BBJ requires GRCh37, others GRCh38", () => {
		expect(COHORT_BUILD.bbj).toBe("GRCh37");
		expect(COHORT_BUILD.finngen).toBe("GRCh38");
		expect(COHORT_BUILD["ukb-topmed"]).toBe("GRCh38");
		expect(COHORT_BUILD.tpmi).toBe("GRCh38");
	});
});

describe("lookupRsid", () => {
	it("returns coords for matching assembly_name", async () => {
		const fetchImpl = makeFetchStub({
			"/variation/human/rs123": {
				mappings: [
					{
						assembly_name: "GRCh38",
						seq_region_name: "1",
						start: 12345,
						allele_string: "A/G",
					},
				],
			},
		});
		const result = await lookupRsid("rs123", "GRCh38", { fetchImpl });
		expect(result).toEqual({ chr: "1", pos: 12345, ref: "A", alts: ["G"] });
	});
	it("returns null when no matching assembly", async () => {
		const fetchImpl = makeFetchStub({
			"/variation/human/rs1": { mappings: [{ assembly_name: "GRCh37" }] },
		});
		const result = await lookupRsid("rs1", "GRCh38", { fetchImpl });
		expect(result).toBeNull();
	});
});

describe("lookupPosition", () => {
	it("finds first rs-prefixed variant", async () => {
		const fetchImpl = makeFetchStub({
			"/overlap/region/human/1:100-100": [
				{ id: "12345" },
				{ id: "rs999", alleles: ["A", "G", "T"] },
			],
		});
		const result = await lookupPosition("1", 100, "GRCh38", { fetchImpl });
		expect(result).toEqual({ rsid: "rs999", ref: "A", alts: ["G", "T"] });
	});
});

describe("resolveRsid", () => {
	it("returns both builds when both lookups succeed", async () => {
		const fetchImpl = makeFetchStub({
			"https://rest.ensembl.org/variation/human/rs1": {
				mappings: [
					{ assembly_name: "GRCh38", seq_region_name: "1", start: 200, allele_string: "A/G" },
				],
			},
			"https://grch37.rest.ensembl.org/variation/human/rs1": {
				mappings: [
					{ assembly_name: "GRCh37", seq_region_name: "1", start: 100, allele_string: "A/G" },
				],
			},
		});
		const r = await resolveRsid("rs1", { fetchImpl });
		expect(r.rsid).toBe("rs1");
		expect(r.grch38?.canonical).toBe("1:200-A-G");
		expect(r.grch37?.canonical).toBe("1:100-A-G");
	});

	it("throws on input not starting with 'rs'", async () => {
		await expect(resolveRsid("12345")).rejects.toThrow(/rsid must start/);
	});
});

describe("resolveVariant grch38 input", () => {
	it("round-trips via Ensembl overlap + rsID lookup", async () => {
		const fetchImpl = makeFetchStub({
			"https://rest.ensembl.org/overlap/region/human/1:200-200": [
				{ id: "rs1", alleles: ["A", "G"] },
			],
			"https://grch37.rest.ensembl.org/variation/human/rs1": {
				mappings: [
					{ assembly_name: "GRCh37", seq_region_name: "1", start: 100, allele_string: "A/G" },
				],
			},
		});
		const r = await resolveVariant("grch38", "1-200-A-G", { fetchImpl });
		expect(r.rsid).toBe("rs1");
		expect(r.grch38?.canonical).toBe("1:200-A-G");
		expect(r.grch37?.canonical).toBe("1:100-A-G");
	});

	it("warns when input ref differs from resolved ref", async () => {
		const fetchImpl = makeFetchStub({
			"/overlap/region/human/1:200-200": [{ id: "rs1", alleles: ["T", "G"] }],
			"/variation/human/rs1": { mappings: [] },
		});
		const r = await resolveVariant("grch38", "1-200-A-G", { fetchImpl });
		expect(r.warnings.some((w) => w.includes("Input ref"))).toBe(true);
	});

	it("throws not_found when no rsID exists at position", async () => {
		const fetchImpl = makeFetchStub({
			"/overlap/region/human/1:200-200": [],
		});
		await expect(resolveVariant("grch38", "1-200-A-G", { fetchImpl })).rejects.toBeInstanceOf(
			VariantResolutionError,
		);
	});
});

describe("liftover", () => {
	it("returns same coords when fromBuild === toBuild", async () => {
		const result = await liftover(
			{ chr: "1", pos: 100, ref: "A", alt: "G" },
			"GRCh38",
			"GRCh38",
		);
		expect(result.canonical).toBe("1:100-A-G");
	});

	it("rounds-trips GRCh37 -> GRCh38 via Ensembl", async () => {
		const fetchImpl = makeFetchStub({
			"https://grch37.rest.ensembl.org/overlap/region/human/1:100-100": [
				{ id: "rs1", alleles: ["A", "G"] },
			],
			"https://rest.ensembl.org/variation/human/rs1": {
				mappings: [
					{ assembly_name: "GRCh38", seq_region_name: "1", start: 200, allele_string: "A/G" },
				],
			},
		});
		const result = await liftover(
			{ chr: "1", pos: 100, ref: "A", alt: "G" },
			"GRCh37",
			"GRCh38",
			{ fetchImpl },
		);
		expect(result).toEqual({ chr: "1", pos: 200, ref: "A", alt: "G", canonical: "1:200-A-G" });
	});

	it("throws when target build has no mapping", async () => {
		const fetchImpl = makeFetchStub({
			"https://grch37.rest.ensembl.org/overlap/region/human/1:100-100": [
				{ id: "rs1", alleles: ["A", "G"] },
			],
			"https://rest.ensembl.org/variation/human/rs1": { mappings: [] },
		});
		await expect(
			liftover({ chr: "1", pos: 100, ref: "A", alt: "G" }, "GRCh37", "GRCh38", { fetchImpl }),
		).rejects.toBeInstanceOf(VariantResolutionError);
	});
});
