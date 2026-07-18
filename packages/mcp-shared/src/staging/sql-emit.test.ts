import { describe, expect, it } from "vitest";
import { dedupeColumnsByNameCI, quoteIdent, sqlValue } from "./sql-emit";

describe("sqlValue", () => {
	it("passes scalars through, coerces null/undefined to null", () => {
		expect(sqlValue("x")).toBe("x");
		expect(sqlValue(42)).toBe(42);
		expect(sqlValue(null)).toBeNull();
		expect(sqlValue(undefined)).toBeNull();
	});

	it("coerces a boolean to 0/1 (SQLite's binder rejects a JS boolean)", () => {
		expect(sqlValue(true)).toBe(1);
		expect(sqlValue(false)).toBe(0);
	});

	it("pipe-delimits a scalar array and JSON-encodes an object array", () => {
		expect(sqlValue([1, 2, 3])).toBe("1 | 2 | 3");
		expect(sqlValue([])).toBeNull();
		expect(sqlValue([{ a: 1 }])).toBe('[{"a":1}]'); // no [object Object] loss
	});

	it("JSON-encodes a plain object", () => {
		expect(sqlValue({ a: 1 })).toBe('{"a":1}');
	});
});

describe("quoteIdent", () => {
	it("wraps in double-quotes and escapes embedded double-quotes", () => {
		expect(quoteIdent("gene")).toBe('"gene"');
		expect(quoteIdent('a"b')).toBe('"a""b"');
	});
});

describe("dedupeColumnsByNameCI", () => {
	it("drops case-insensitive duplicates, keeping the first", () => {
		// SQLite treats these as one column; emitting both threw and lost the table.
		expect(dedupeColumnsByNameCI([{ name: "Gene" }, { name: "gene" }, { name: "GENE" }])).toEqual([
			{ name: "Gene" },
		]);
		expect(dedupeColumnsByNameCI([{ name: "id" }, { name: "symbol" }, { name: "ID" }])).toEqual([
			{ name: "id" },
			{ name: "symbol" },
		]);
	});

	it("leaves genuinely distinct columns untouched", () => {
		const cols = [{ name: "a" }, { name: "b" }, { name: "c" }];
		expect(dedupeColumnsByNameCI(cols)).toEqual(cols);
	});
});
