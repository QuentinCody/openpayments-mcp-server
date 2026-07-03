import { describe, expect, it } from "vitest";
import type { RowChange } from "../types";
import { fdaOrangeBook } from "./fda-orange-book";

describe("fdaOrangeBook.buildQuery", () => {
	it("targets orange_book_execute with exact-match code for the NDA", () => {
		const q = fdaOrangeBook.buildQuery({ nda: "202155" });
		expect(q.server).toBe("fda-orange-book");
		expect(q.tool).toBe("orange_book_execute");
		const code = String(q.params.code);
		expect(code).toContain('"202155"');
		expect(code).toContain("/exclusivity");
		expect(code).toContain("/patents");
		expect(code).toContain("r.Appl_No === APPL");
	});
	it("accepts appl_no as an alias for nda", () => {
		const q = fdaOrangeBook.buildQuery({ appl_no: "021436" });
		expect(String(q.params.code)).toContain('"021436"');
	});
});

const change = (over: Partial<RowChange>): RowChange => ({
	table: "patents",
	kind: "changed",
	key: "k",
	keyValues: {},
	...over,
});

describe("fdaOrangeBook.classify", () => {
	const classify = fdaOrangeBook.classify;
	if (!classify) throw new Error("fdaOrangeBook must define classify");

	it("flags a removed exclusivity as the high-materiality cliff", () => {
		expect(
			classify(change({ table: "exclusivity", kind: "removed" })).materiality,
		).toBe("high");
	});
	it("flags a removed patent as high", () => {
		expect(
			classify(change({ table: "patents", kind: "removed" })).materiality,
		).toBe("high");
	});
	it("flags a patent delist flip as high", () => {
		const c = change({
			kind: "changed",
			fields: [{ field: "Delist_Flag", before: "", after: "Y" }],
		});
		expect(classify(c).materiality).toBe("high");
		expect(classify(c).label.toLowerCase()).toContain("delist");
	});
	it("flags an expiry-date move as high", () => {
		const c = change({
			kind: "changed",
			fields: [
				{
					field: "Patent_Expire_Date_Text",
					before: "Nov 21, 2026",
					after: "May 21, 2027",
				},
			],
		});
		expect(classify(c).materiality).toBe("high");
	});
	it("treats a newly-added patent as informational", () => {
		expect(classify(change({ kind: "added" })).materiality).toBe("info");
	});
	it("labels a newly-added exclusivity", () => {
		const r = classify(change({ table: "exclusivity", kind: "added" }));
		expect(r.materiality).toBe("info");
		expect(r.label.toLowerCase()).toContain("exclusivity");
	});
	it("treats a non-cliff field change as informational (Updated)", () => {
		const c = change({
			kind: "changed",
			fields: [{ field: "Drug_Substance_Flag", before: "Y", after: "N" }],
		});
		expect(classify(c).materiality).toBe("info");
		expect(classify(c).label).toContain("Updated");
	});
});
