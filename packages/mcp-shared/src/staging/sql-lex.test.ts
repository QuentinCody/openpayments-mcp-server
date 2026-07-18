import { describe, expect, it } from "vitest";
import { blankQuotedLiterals, stripLineComments, stripTrailingSemicolons } from "./sql-lex";

describe("blankQuotedLiterals", () => {
	it("preserves length and code structure", () => {
		const s = "SELECT 'abc' FROM t";
		expect(blankQuotedLiterals(s)).toHaveLength(s.length);
		expect(blankQuotedLiterals(s)).toBe("SELECT '   ' FROM t");
	});

	it("blanks a keyword inside a string (fixes the false-reject)", () => {
		expect(blankQuotedLiterals("SELECT 'insert' AS x")).toBe("SELECT '      ' AS x");
	});

	it("SECURITY: leaves a bare write keyword outside strings untouched", () => {
		expect(blankQuotedLiterals("DROP TABLE t")).toBe("DROP TABLE t");
		expect(blankQuotedLiterals("SELECT 'x'; DELETE FROM t")).toBe("SELECT ' '; DELETE FROM t");
	});

	it("SECURITY: a doubled '' escape does not expose or hide following code", () => {
		// 'a''b' is ONE string containing a'b — not close, DROP, reopen.
		expect(blankQuotedLiterals("SELECT 'a''b' AS x")).toBe("SELECT '    ' AS x");
		expect(blankQuotedLiterals("SELECT 'a''DELETE''b' FROM t")).toBe("SELECT '            ' FROM t");
	});

	it("SECURITY: blanks [bracket] identifier contents (rs2 #1)", () => {
		// A dash-dash inside [ ] is an identifier, not a comment; a keyword inside is
		// data, not a command. Missing this hid a chained write behind `[x--y]`.
		expect(blankQuotedLiterals("SELECT 1 AS [x--y]")).toBe("SELECT 1 AS [    ]");
		expect(blankQuotedLiterals("SELECT [DELETE] FROM t")).toBe("SELECT [      ] FROM t");
	});

	it("SECURITY: does NOT treat backslash as an escape (SQLite has none)", () => {
		// SQLite closes the quote at the first ' after a backslash. `'x\'` is the
		// complete string "x\"; a following DELETE is CODE and must stay visible.
		// (A mutant lexer treating \' as an escape would blank it away — rs2 #11.)
		expect(blankQuotedLiterals("SELECT 'x\\'; DELETE FROM t")).toContain("DELETE");
	});

	it("handles double-quote and backtick identifiers the same way", () => {
		expect(blankQuotedLiterals('SELECT "drop" FROM t')).toBe('SELECT "    " FROM t');
		expect(blankQuotedLiterals("SELECT `drop` FROM t")).toBe("SELECT `    ` FROM t");
	});

	it("blanks to end on an unterminated quote (never throws)", () => {
		expect(blankQuotedLiterals("SELECT 'abc")).toBe("SELECT '   ");
	});
});

describe("stripLineComments", () => {
	it("removes a code line comment", () => {
		expect(stripLineComments("SELECT 1 -- drop table t").trimEnd()).toBe("SELECT 1");
	});

	it("does NOT remove a -- inside a string literal", () => {
		expect(stripLineComments("WHERE n = 'a -- b'")).toBe("WHERE n = 'a -- b'");
	});

	it("SECURITY: a -- inside a string cannot swallow a following statement", () => {
		// The write-bypass: raw `--.*$` strips `; DROP…`, hiding it from the guard.
		expect(stripLineComments("SELECT '--'; DELETE FROM t")).toBe("SELECT '--'; DELETE FROM t");
	});

	it("preserves a doubled-quote escape while stripping a later code comment", () => {
		expect(stripLineComments("SELECT 'a''b' -- note").trimEnd()).toBe("SELECT 'a''b'");
	});
});

describe("stripTrailingSemicolons", () => {
	it("strips trailing semicolons and whitespace", () => {
		expect(stripTrailingSemicolons("SELECT 1 ;  ")).toBe("SELECT 1");
		expect(stripTrailingSemicolons("SELECT 1;;;")).toBe("SELECT 1");
	});

	it("leaves interior semicolons alone", () => {
		expect(stripTrailingSemicolons("SELECT 1; SELECT 2")).toBe("SELECT 1; SELECT 2");
	});

	it("is linear on a long semicolon run (no ReDoS)", () => {
		const bomb = `SELECT ${";".repeat(50000)}`;
		const t0 = performance.now();
		stripTrailingSemicolons(bomb);
		expect(performance.now() - t0).toBeLessThan(100);
	});
});
