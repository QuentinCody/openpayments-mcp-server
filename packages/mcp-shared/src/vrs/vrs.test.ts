/**
 * Vectors are byte-exact expectations lifted from the GA4GH reference
 * implementation (ga4gh/vrs-python `tests/test_vrs.py`) and the VRS spec's
 * computed-identifier page. They are an external contract: if any of these
 * change, our identifiers have stopped matching the rest of the ecosystem.
 */
import { describe, expect, it } from "vitest";
import {
	type Allele,
	alleleDigest,
	alleleFromCoords,
	alleleFromVcf,
	alleleId,
	isVrsId,
	refgetAccessionForSequence,
	sequenceLocationDigest,
	sequenceLocationId,
	serializeAllele,
	serializeSequenceLocation,
	serializeSequenceReference,
	sha512t24u,
	VrsError,
} from "./vrs";

/** vrs-python `allele_dict` — EGFR NC_000007.14:g.55181320A>T. */
const EGFR_ALLELE: Allele = {
	type: "Allele",
	location: {
		type: "SequenceLocation",
		sequenceReference: {
			type: "SequenceReference",
			refgetAccession: "SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul",
		},
		start: 55181319,
		end: 55181320,
	},
	state: { type: "LiteralSequenceExpression", sequence: "T" },
};

/** vrs-python `allele_383650_dict` — carries its own expected id and digest. */
const ALLELE_383650: Allele = {
	type: "Allele",
	location: {
		type: "SequenceLocation",
		sequenceReference: {
			type: "SequenceReference",
			refgetAccession: "SQ.KEO-4XBcm1cxeo_DIQ8_ofqGUkp4iZhI",
		},
		start: 128325834,
		end: 128325835,
	},
	state: { type: "LiteralSequenceExpression", sequence: "T" },
};

/** The VRS spec's own computed-identifiers worked example. */
const SPEC_EXAMPLE: Allele = {
	type: "Allele",
	location: {
		type: "SequenceLocation",
		sequenceReference: {
			type: "SequenceReference",
			refgetAccession: "SQ.IIB53T8CNeJJdUqzn9V_JnRtQadwWCbl",
		},
		start: 44908821,
		end: 44908822,
	},
	state: { type: "LiteralSequenceExpression", sequence: "T" },
};

describe("sha512t24u", () => {
	it("reproduces the spec test vector", async () => {
		expect(await sha512t24u("ACGT")).toBe("aKF498dAxcJAqme6QYQ7EZ07-fiw8Kw2");
	});

	it("accepts raw bytes equivalently to the string form", async () => {
		const bytes = new TextEncoder().encode("ACGT");
		expect(await sha512t24u(bytes)).toBe("aKF498dAxcJAqme6QYQ7EZ07-fiw8Kw2");
	});

	it("always produces a 32-character base64url digest", async () => {
		for (const input of ["", "A", "ACGT", "x".repeat(5000)]) {
			const digest = await sha512t24u(input);
			expect(digest).toHaveLength(32);
			expect(digest).toMatch(/^[A-Za-z0-9_-]{32}$/);
		}
	});
});

describe("ga4gh serialization", () => {
	it("serializes a SequenceReference inline, not as a digest", () => {
		expect(
			serializeSequenceReference(EGFR_ALLELE.location.sequenceReference),
		).toBe(
			'{"refgetAccession":"SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul","type":"SequenceReference"}',
		);
	});

	it("serializes a SequenceLocation with the nested reference expanded", () => {
		expect(serializeSequenceLocation(EGFR_ALLELE.location)).toBe(
			'{"end":55181320,"sequenceReference":{"refgetAccession":"SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul","type":"SequenceReference"},"start":55181319,"type":"SequenceLocation"}',
		);
	});

	it("serializes an Allele with its location replaced by a bare digest", async () => {
		expect(await serializeAllele(EGFR_ALLELE)).toBe(
			'{"location":"_G2K0qSioM74l_u3OaKR0mgLYdeTL7Xd","state":{"sequence":"T","type":"LiteralSequenceExpression"},"type":"Allele"}',
		);
	});
});

describe("computed identifiers", () => {
	it("matches the reference implementation for the EGFR allele", async () => {
		expect(await sequenceLocationDigest(EGFR_ALLELE.location)).toBe(
			"_G2K0qSioM74l_u3OaKR0mgLYdeTL7Xd",
		);
		expect(await sequenceLocationId(EGFR_ALLELE.location)).toBe(
			"ga4gh:SL._G2K0qSioM74l_u3OaKR0mgLYdeTL7Xd",
		);
		expect(await alleleDigest(EGFR_ALLELE)).toBe(
			"Hy2XU_-rp4IMh6I_1NXNecBo8Qx8n0oE",
		);
		expect(await alleleId(EGFR_ALLELE)).toBe(
			"ga4gh:VA.Hy2XU_-rp4IMh6I_1NXNecBo8Qx8n0oE",
		);
	});

	it("matches the reference implementation for ClinVar 383650", async () => {
		expect(await sequenceLocationId(ALLELE_383650.location)).toBe(
			"ga4gh:SL.TaoXEhpHvA6SdilBUO-AX00YDARv9Uoe",
		);
		expect(await alleleId(ALLELE_383650)).toBe(
			"ga4gh:VA.SZIS2ua7AL-0YgUTAqyBsFPYK3vE8h_d",
		);
	});

	/**
	 * The allele id here is the VRS spec's published computed-identifiers
	 * example, NOT vrs-python's `test_enref2` fixture. That fixture hardcodes
	 * `ga4gh:VA.LDzK5JahEZG2Ua_5itDtVV8v3O1ptTgI` and never recomputes it —
	 * pydantic simply accepts the supplied `id`/`digest`, so nothing in that
	 * test validates the value. Its SequenceLocation digest (asserted below)
	 * does match ours, and the spec's own published allele id matches ours to
	 * all 32 characters, so the fixture id is stale.
	 */
	it("matches the spec's own worked example", async () => {
		expect(await sequenceLocationId(SPEC_EXAMPLE.location)).toBe(
			"ga4gh:SL.wIlaGykfwHIpPY2Fcxtbx4TINbbODFVz",
		);
		expect(await alleleId(SPEC_EXAMPLE)).toBe(
			"ga4gh:VA.0AePZIWZUNsUlQTamyLrjm2HWUw2opLt",
		);
	});

	it("is deterministic and independent of key insertion order", async () => {
		const reordered: Allele = {
			state: { sequence: "T", type: "LiteralSequenceExpression" },
			location: {
				end: 55181320,
				start: 55181319,
				sequenceReference: {
					refgetAccession: "SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul",
					type: "SequenceReference",
				},
				type: "SequenceLocation",
			},
			type: "Allele",
		};
		expect(await alleleId(reordered)).toBe(await alleleId(EGFR_ALLELE));
	});

	it("gives different identifiers to different alt alleles", async () => {
		const alternate: Allele = {
			...EGFR_ALLELE,
			state: { type: "LiteralSequenceExpression", sequence: "G" },
		};
		expect(await alleleId(alternate)).not.toBe(await alleleId(EGFR_ALLELE));
	});
});

describe("coordinate constructors", () => {
	it("builds the EGFR allele from interbase coordinates", async () => {
		const built = alleleFromCoords({
			refgetAccession: "SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul",
			start: 55181319,
			end: 55181320,
			alt: "T",
		});
		expect(await alleleId(built)).toBe(
			"ga4gh:VA.Hy2XU_-rp4IMh6I_1NXNecBo8Qx8n0oE",
		);
	});

	it("converts 1-based VCF coordinates to the same identifier", async () => {
		const built = alleleFromVcf({
			refgetAccession: "SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul",
			position: 55181320,
			ref: "A",
			alt: "T",
		});
		expect(await alleleId(built)).toBe(
			"ga4gh:VA.Hy2XU_-rp4IMh6I_1NXNecBo8Qx8n0oE",
		);
	});

	it("spans the full ref length for a multi-base VCF deletion", () => {
		const built = alleleFromVcf({
			refgetAccession: "SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul",
			position: 100,
			ref: "ACGT",
			alt: "",
		});
		expect(built.location.start).toBe(99);
		expect(built.location.end).toBe(103);
		expect(built.state.sequence).toBe("");
	});

	it("upper-cases the alt allele so case cannot fork the identifier", async () => {
		const lower = alleleFromCoords({
			refgetAccession: "SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul",
			start: 55181319,
			end: 55181320,
			alt: "t",
		});
		expect(await alleleId(lower)).toBe(
			"ga4gh:VA.Hy2XU_-rp4IMh6I_1NXNecBo8Qx8n0oE",
		);
	});
});

describe("refgetAccessionForSequence", () => {
	it("derives an accession that is the spec digest of the residues", async () => {
		expect(await refgetAccessionForSequence("ACGT")).toBe(
			"SQ.aKF498dAxcJAqme6QYQ7EZ07-fiw8Kw2",
		);
	});

	it("is case-insensitive, so soft-masked sequence cannot fork the accession", async () => {
		expect(await refgetAccessionForSequence("acgt")).toBe(
			await refgetAccessionForSequence("ACGT"),
		);
	});

	it("produces an accession the Allele constructors accept", async () => {
		const accession = await refgetAccessionForSequence("ACGT");
		expect(() =>
			alleleFromCoords({
				refgetAccession: accession,
				start: 0,
				end: 1,
				alt: "T",
			}),
		).not.toThrow();
	});

	it("rejects an empty sequence", async () => {
		await expect(refgetAccessionForSequence("")).rejects.toThrow(VrsError);
	});
});

describe("input validation", () => {
	it("rejects a namespace-prefixed refget accession", () => {
		expect(() =>
			alleleFromCoords({
				refgetAccession: "ga4gh:SQ.KEO-4XBcm1cxeo_DIQ8_ofqGUkp4iZhI",
				start: 1,
				end: 2,
				alt: "T",
			}),
		).toThrow(VrsError);
	});

	it("rejects a malformed refget accession", () => {
		expect(() =>
			alleleFromCoords({
				refgetAccession: "SQ.tooshort",
				start: 1,
				end: 2,
				alt: "T",
			}),
		).toThrow(/SQ\.<32/);
	});

	it("rejects an inverted interval", () => {
		expect(() =>
			alleleFromCoords({
				refgetAccession: "SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul",
				start: 500,
				end: 100,
				alt: "T",
			}),
		).toThrow(/end must be >= start/);
	});

	it("rejects a negative start", () => {
		expect(() =>
			alleleFromCoords({
				refgetAccession: "SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul",
				start: -1,
				end: 2,
				alt: "T",
			}),
		).toThrow(/start must be >= 0/);
	});

	it("rejects a non-integer VCF position", () => {
		expect(() =>
			alleleFromVcf({
				refgetAccession: "SQ.F-LrLMe1SRpfUZHkQmvkVKFEGaoDeHul",
				position: 0,
				ref: "A",
				alt: "T",
			}),
		).toThrow(/1-based integer/);
	});
});

describe("isVrsId", () => {
	it("accepts well-formed Allele and SequenceLocation CURIEs", () => {
		expect(isVrsId("ga4gh:VA.Hy2XU_-rp4IMh6I_1NXNecBo8Qx8n0oE")).toBe(true);
		expect(isVrsId("ga4gh:SL._G2K0qSioM74l_u3OaKR0mgLYdeTL7Xd")).toBe(true);
	});

	it("accepts a syntactically valid id even when it is not the right one", () => {
		// The reference suite's `syntax_valid_id`: 32 base64url-legal characters,
		// so it is well-formed. isVrsId checks shape, never correctness — only
		// recomputing the digest can tell you an id is the *right* id.
		expect(isVrsId("ga4gh:VA.39eae078d9bb30da2a5c5d1969cb1472")).toBe(true);
	});

	it("rejects wrong-length digests, wrong prefixes and non-strings", () => {
		expect(isVrsId("ga4gh:VA.tooshort")).toBe(false);
		expect(isVrsId("ga4gh:12345")).toBe(false);
		expect(isVrsId("VA.Hy2XU_-rp4IMh6I_1NXNecBo8Qx8n0oE")).toBe(false);
		expect(isVrsId(42)).toBe(false);
		expect(isVrsId(null)).toBe(false);
	});
});
