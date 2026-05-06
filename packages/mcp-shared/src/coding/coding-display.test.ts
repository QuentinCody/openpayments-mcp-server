import { describe, expect, it } from "vitest";

import { CLINICAL_SYSTEMS } from "./code-systems";
import {
	CodingDictRegistry,
	buildRegistry,
	firstCode,
	safeCodingDisplay,
	safeConceptDisplay,
} from "./coding-display";
import { LOINC_VITALS_REGISTRATION } from "./dicts/loinc-vitals";

describe("safeCodingDisplay", () => {
	it("prefers an explicit display", () => {
		expect(safeCodingDisplay({ system: CLINICAL_SYSTEMS.loinc.uri, code: "8302-2", display: "Height" })).toBe(
			"Height",
		);
	});

	it("falls back to dict lookup when display is missing", () => {
		const registry = buildRegistry([LOINC_VITALS_REGISTRATION]);
		expect(safeCodingDisplay({ system: CLINICAL_SYSTEMS.loinc.uri, code: "8302-2" }, registry)).toBe("Body height");
	});

	it("falls back to system|code when no dict matches", () => {
		expect(safeCodingDisplay({ system: "http://example.com/system", code: "X1" })).toBe(
			"http://example.com/system|X1",
		);
	});

	it("returns bare code when no system", () => {
		expect(safeCodingDisplay({ code: "X1" })).toBe("X1");
	});

	it("returns undefined for empty coding", () => {
		expect(safeCodingDisplay({})).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(safeCodingDisplay(undefined)).toBeUndefined();
	});

	it("ignores empty-string display, falls through to dict", () => {
		const registry = buildRegistry([LOINC_VITALS_REGISTRATION]);
		expect(safeCodingDisplay({ system: CLINICAL_SYSTEMS.loinc.uri, code: "29463-7", display: "" }, registry)).toBe(
			"Body weight",
		);
	});
});

describe("safeConceptDisplay", () => {
	const registry = buildRegistry([LOINC_VITALS_REGISTRATION]);

	it("prefers concept.text", () => {
		expect(safeConceptDisplay({ text: "Diabetes" })).toBe("Diabetes");
	});

	it("falls back to first coding's display", () => {
		expect(
			safeConceptDisplay({ coding: [{ system: "x", code: "1", display: "Foo" }, { code: "2" }] }),
		).toBe("Foo");
	});

	it("skips first coding if no display, tries second", () => {
		expect(
			safeConceptDisplay({
				coding: [
					{ system: "unknown", code: "1" },
					{ system: CLINICAL_SYSTEMS.loinc.uri, code: "8867-4" },
				],
			}, registry),
		).toBe("Heart rate");
	});

	it("returns undefined when nothing resolves", () => {
		expect(safeConceptDisplay({})).toBeUndefined();
		expect(safeConceptDisplay({ coding: [] })).toBeUndefined();
		expect(safeConceptDisplay(undefined)).toBeUndefined();
	});
});

describe("firstCode", () => {
	it("returns the first coding's code", () => {
		expect(firstCode({ coding: [{ code: "active" }, { code: "resolved" }] })).toBe("active");
	});

	it("returns undefined when empty", () => {
		expect(firstCode({})).toBeUndefined();
		expect(firstCode(undefined)).toBeUndefined();
	});
});

describe("CodingDictRegistry", () => {
	it("registers and looks up", () => {
		const r = new CodingDictRegistry();
		r.register("http://example.com", { A1: "Alpha One" });
		expect(r.lookup("http://example.com", "A1")).toBe("Alpha One");
		expect(r.lookup("http://example.com", "missing")).toBeUndefined();
		expect(r.lookup("unknown", "A1")).toBeUndefined();
	});

	it("knownSystems lists registered URIs", () => {
		const r = buildRegistry([LOINC_VITALS_REGISTRATION]);
		expect(r.knownSystems()).toContain(CLINICAL_SYSTEMS.loinc.uri);
	});
});
