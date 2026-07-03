import { describe, expect, it } from "vitest";
import {
	effectiveStagingThreshold,
	isSingleRecordResponse,
} from "./single-record";

describe("isSingleRecordResponse (T10.1)", () => {
	it("treats a single entity as single — even with large nested object-arrays", () => {
		// A single UniProt-style entry: nested `features`/`dbReferences` arrays, but
		// it is ONE entity (no top-level results/hits/nodes collection).
		const entry = {
			accession: "Q9BZS1",
			id: "FOXP3_HUMAN",
			features: Array.from({ length: 40 }, (_, i) => ({
				type: "domain",
				start: i,
			})),
			dbReferences: Array.from({ length: 60 }, (_, i) => ({
				db: "PDB",
				id: String(i),
			})),
		};
		expect(isSingleRecordResponse(entry)).toBe(true);
	});

	it("treats a list under a known collection key as multi-row", () => {
		expect(isSingleRecordResponse({ results: [{ a: 1 }, { a: 2 }] })).toBe(
			false,
		);
		expect(isSingleRecordResponse({ hits: [{ a: 1 }, { a: 2 }] })).toBe(false);
	});

	it("treats a GraphQL one-level-nested collection as multi-row", () => {
		expect(
			isSingleRecordResponse({ genes: { nodes: [{ a: 1 }, { a: 2 }] } }),
		).toBe(false);
	});

	it("treats a top-level array of >1 as multi-row, and a 0/1-element list as single", () => {
		expect(isSingleRecordResponse([{ a: 1 }, { a: 2 }])).toBe(false);
		expect(isSingleRecordResponse([{ a: 1 }])).toBe(true);
		expect(isSingleRecordResponse([])).toBe(true);
	});

	it("treats scalars and a single wrapped object as single", () => {
		expect(isSingleRecordResponse("BRCA1")).toBe(true);
		expect(isSingleRecordResponse({ data: { accession: "X" } })).toBe(true);
		expect(isSingleRecordResponse({ results: [{ only: 1 }] })).toBe(true);
	});
});

describe("effectiveStagingThreshold (T10.1)", () => {
	it("raises the threshold for a single record so it stays inline", () => {
		const base = 30 * 1024;
		const single = effectiveStagingThreshold(
			{ accession: "X", features: [{ a: 1 }, { a: 2 }] },
			base,
		);
		expect(single).toBeGreaterThan(base);
	});

	it("keeps the base threshold for a multi-row list", () => {
		const base = 30 * 1024;
		expect(
			effectiveStagingThreshold({ results: [{ a: 1 }, { a: 2 }] }, base),
		).toBe(base);
	});

	it("falls back to a default base when none is provided", () => {
		expect(
			effectiveStagingThreshold({ results: [{ a: 1 }, { a: 2 }] }, undefined),
		).toBe(30 * 1024);
	});
});
