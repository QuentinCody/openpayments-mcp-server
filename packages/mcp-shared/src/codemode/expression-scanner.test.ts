import { describe, expect, it } from "vitest";
import {
	findTopLevelArrow,
	findTopLevelChar,
	findTopLevelOperator,
	parseArrowParam,
	parseCallExpressionAt,
	parseMemberAccess,
	parseOptionalMemberAccess,
	parseSpecLookupTokens,
	readQuotedString,
	splitTopLevelExpressions,
	stripOuterParens,
	unsupportedExpression,
} from "./expression-scanner";

describe("unsupportedExpression", () => {
	it("throws a SyntaxError sentinel", () => {
		expect(() => unsupportedExpression()).toThrow(SyntaxError);
		expect(() => unsupportedExpression()).toThrow("UNSUPPORTED_EXPRESSION");
	});
});

describe("readQuotedString", () => {
	it("reads a plain string and reports the next position", () => {
		const { value, nextPos } = readQuotedString('"hello" rest', 0);
		expect(value).toBe("hello");
		expect(nextPos).toBe(7);
	});
	it("decodes escape sequences", () => {
		expect(readQuotedString('"a\\nb\\tc\\\\d\\"e"', 0).value).toBe(
			'a\nb\tc\\d"e',
		);
	});
	it("throws on an unterminated string", () => {
		expect(() => readQuotedString('"oops', 0)).toThrow();
	});
});

describe("parseSpecLookupTokens", () => {
	it("returns dotted + bracketed tokens after spec/SPEC", () => {
		expect(parseSpecLookupTokens("spec.info.title")).toEqual(["info", "title"]);
		expect(parseSpecLookupTokens('SPEC["paths"]')).toEqual(["paths"]);
		expect(parseSpecLookupTokens("spec")).toEqual([]);
	});
	it("returns null for non-spec roots or optional chaining", () => {
		expect(parseSpecLookupTokens("other.x")).toBe(null);
		expect(parseSpecLookupTokens("spec.info?.title")).toBe(null);
		expect(parseSpecLookupTokens("spec.5")).toBe(null);
	});
});

describe("splitTopLevelExpressions", () => {
	it("splits on top-level commas only", () => {
		expect(splitTopLevelExpressions("a, b, c")).toEqual(["a", "b", "c"]);
		expect(splitTopLevelExpressions("f(a, b), c")).toEqual(["f(a, b)", "c"]);
		expect(splitTopLevelExpressions('"x,y", z')).toEqual(['"x,y"', "z"]);
		expect(splitTopLevelExpressions("[1, 2], {a: 1}")).toEqual([
			"[1, 2]",
			"{a: 1}",
		]);
	});
	it("ignores escaped quotes inside strings", () => {
		expect(splitTopLevelExpressions('"a\\",b", c')).toEqual(['"a\\",b"', "c"]);
	});
});

describe("parseCallExpressionAt", () => {
	it("parses callee + args for a simple and dotted call", () => {
		expect(parseCallExpressionAt("foo(a, b)")).toEqual({
			callee: "foo",
			argsStr: "a, b",
			nextPos: 9,
		});
		expect(parseCallExpressionAt("a.b.c(x)")?.callee).toBe("a.b.c");
	});
	it("handles nested parens and quoted parens in args", () => {
		expect(parseCallExpressionAt("f(g(1), 2)")?.argsStr).toBe("g(1), 2");
		expect(parseCallExpressionAt('f("a)b")')?.argsStr).toBe('"a)b"');
	});
	it("returns null when there is no call", () => {
		expect(parseCallExpressionAt("nope")).toBe(null);
		expect(parseCallExpressionAt("123(x)")).toBe(null);
	});
});

describe("stripOuterParens", () => {
	it("strips wrapping parens but not partial groupings", () => {
		expect(stripOuterParens("((x))")).toBe("x");
		expect(stripOuterParens("  ( a ) ")).toBe("a");
		expect(stripOuterParens("(a) + (b)")).toBe("(a) + (b)");
	});
});

describe("findTopLevelArrow", () => {
	it("finds a top-level => and ignores nested ones", () => {
		expect(findTopLevelArrow("x => y")).toBe(2);
		expect(findTopLevelArrow("(a => b)")).toBe(-1);
		expect(findTopLevelArrow("no arrow here")).toBe(-1);
	});
});

describe("findTopLevelOperator", () => {
	it("returns the first top-level operator match", () => {
		expect(findTopLevelOperator("a + b", ["+", "-"])).toEqual({
			index: 2,
			operator: "+",
		});
		expect(findTopLevelOperator("f(a+b) - c", ["+", "-"])).toEqual({
			index: 7,
			operator: "-",
		});
		expect(findTopLevelOperator('"a+b"', ["+"])).toBe(null);
	});
});

describe("findTopLevelChar", () => {
	it("finds a top-level char and skips nested/quoted ones", () => {
		expect(findTopLevelChar("a:b", ":")).toBe(1);
		expect(findTopLevelChar("{x:1}:y", ":")).toBe(5);
		expect(findTopLevelChar("no colon", ":")).toBe(-1);
	});
});

describe("parseMemberAccess", () => {
	it("parses dotted and indexed access", () => {
		expect(parseMemberAccess("a.b.c")).toEqual({
			root: "a",
			segments: ["b", "c"],
		});
		expect(parseMemberAccess("a[0]")).toEqual({ root: "a", segments: [0] });
		expect(parseMemberAccess("a['k']")).toEqual({ root: "a", segments: ["k"] });
	});
	it("returns null for optional chaining or non-identifier roots", () => {
		expect(parseMemberAccess("a?.b")).toBe(null);
		expect(parseMemberAccess("1abc")).toBe(null);
	});
});

describe("parseArrowParam", () => {
	it("parses identifier and array-destructure params", () => {
		expect(parseArrowParam("x")).toEqual({ kind: "identifier", name: "x" });
		expect(parseArrowParam("[a, b]")).toEqual({
			kind: "array",
			names: ["a", "b"],
		});
		expect(parseArrowParam("[a, 1]")).toEqual({
			kind: "array",
			names: ["a", null],
		});
	});
	it("throws on an unsupported param shape", () => {
		expect(() => parseArrowParam("{a}")).toThrow();
	});
});

describe("parseOptionalMemberAccess", () => {
	it("parses optional and non-optional dotted/indexed access", () => {
		expect(parseOptionalMemberAccess("?.x", 0)).toEqual({
			key: "x",
			nextPos: 3,
			optional: true,
		});
		expect(parseOptionalMemberAccess(".y", 0)).toEqual({
			key: "y",
			nextPos: 2,
			optional: false,
		});
		expect(parseOptionalMemberAccess("[0]", 0)).toEqual({
			key: 0,
			nextPos: 3,
			optional: false,
		});
		expect(parseOptionalMemberAccess('["k"]', 0)).toEqual({
			key: "k",
			nextPos: 5,
			optional: false,
		});
	});
	it("returns null when the position is not a member accessor", () => {
		expect(parseOptionalMemberAccess("xyz", 0)).toBe(null);
	});
});
