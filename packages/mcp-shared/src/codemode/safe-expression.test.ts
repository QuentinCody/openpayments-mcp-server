import { describe, expect, it } from "vitest";
import { evaluateCallbackExpression, evaluateSafeExpression } from "./safe-expression";
import { createOpenApiHelpers } from "./search-tool";

// Helper surface for evaluateSafeExpression comes from createOpenApiHelpers;
// a compact spec is enough to exercise every evaluator branch.
const SPEC = {
	info: { title: "Test API", version: "1.0" },
	paths: {
		"/studies": {
			get: {
				operationId: "getStudies",
				summary: "List studies",
				tags: ["study", "search"],
			},
			post: { operationId: "createStudy" },
		},
		"/health": {
			get: { summary: "Health check" },
		},
	},
};

const H = createOpenApiHelpers(JSON.stringify(SPEC));
const ev = (code: string) => evaluateSafeExpression(code, H);
const cb = (src: string, scope: Record<string, unknown> = {}) => evaluateCallbackExpression(src, scope);

describe("evaluateSafeExpression › binary operators", () => {
	it("nullish coalescing", () => {
		expect(ev("1 ?? 2")).toBe(1);
		expect(ev("null ?? 5")).toBe(5);
	});
	it("logical or / and (both arms)", () => {
		expect(ev("0 || 7")).toBe(7);
		expect(ev("3 || 9")).toBe(3);
		expect(ev("1 && 2")).toBe(2);
		expect(ev("0 && 9")).toBe(0);
	});
	it("equality operators (=== !== == !=)", () => {
		expect(ev("1 === 1")).toBe(true);
		expect(ev("1 !== 2")).toBe(true);
		expect(ev("2 == 2")).toBe(true);
		expect(ev("2 != 3")).toBe(true);
	});
	it("relational operators (>= <= > <)", () => {
		expect(ev("2 >= 2")).toBe(true);
		expect(ev("1 <= 2")).toBe(true);
		expect(ev("3 > 2")).toBe(true);
		expect(ev("1 < 2")).toBe(true);
	});
	it("additive: numeric add, string concat, subtract", () => {
		expect(ev("1 + 2")).toBe(3);
		expect(ev('"a" + "b"')).toBe("ab");
		expect(ev("5 - 2")).toBe(3);
	});
	it("multiplicative: multiply and divide", () => {
		expect(ev("2 * 3")).toBe(6);
		expect(ev("6 / 2")).toBe(3);
	});
	it("strips redundant outer parentheses", () => {
		expect(ev("((7))")).toBe(7);
	});
	it("splits at the first operator → right-associative (behavior guard)", () => {
		// 10 - (3 - 2) = 9, NOT (10 - 3) - 2 = 5
		expect(ev("10 - 3 - 2")).toBe(9);
		// 100 / (10 / 2) = 20, NOT (100 / 10) / 2 = 5
		expect(ev("100 / 10 / 2")).toBe(20);
	});
});

describe("evaluateSafeExpression › literals", () => {
	it("string / boolean / null / undefined / number", () => {
		expect(ev('"hi"')).toBe("hi");
		expect(ev("'yo'")).toBe("yo");
		expect(ev("true")).toBe(true);
		expect(ev("false")).toBe(false);
		expect(ev("null")).toBe(null);
		expect(ev("undefined")).toBe(undefined);
		expect(ev("42")).toBe(42);
		expect(ev("-3.5")).toBe(-3.5);
		expect(ev("1e3")).toBe(1000);
	});
});

describe("evaluateSafeExpression › helper functions", () => {
	it("listTags / listCategories", () => {
		expect(ev("listTags()")).toEqual([
			{ tag: "study", count: 1 },
			{ tag: "search", count: 1 },
		]);
		expect(ev("listCategories()")).toEqual([
			{ category: "study", count: 1 },
			{ category: "search", count: 1 },
		]);
	});
	it("searchPaths / searchSpec with 1 and 2 args", () => {
		const both = ev('searchPaths("studies")') as Array<{ path: string }>;
		expect(both).toHaveLength(2);
		expect(both[0].path).toBe("/studies");
		expect(ev('searchPaths("studies", 1)')).toHaveLength(1);
		expect(ev('searchSpec("health")')).toHaveLength(1);
	});
	it("getOperation / getEndpoint", () => {
		expect((ev('getOperation("getStudies")') as { operationId: string }).operationId).toBe("getStudies");
		expect((ev('getEndpoint("/health", "get")') as { path: string }).path).toBe("/health");
	});
	it("describeOperation / describeEndpoint", () => {
		expect(ev('describeOperation("getStudies")')).toContain("GET /studies");
		expect(ev('describeEndpoint("/studies", "post")')).toContain("POST /studies");
	});
});

describe("evaluateSafeExpression › Object.* and spec lookup", () => {
	it("Object.keys / values / entries", () => {
		expect(ev("Object.keys(spec.info)")).toEqual(["title", "version"]);
		expect(ev("Object.values(spec.info)")).toEqual(["Test API", "1.0"]);
		expect(ev("Object.entries(spec.info)")).toEqual([
			["title", "Test API"],
			["version", "1.0"],
		]);
	});
	it("spec / SPEC dotted + bracket lookup", () => {
		expect(ev("spec.info.title")).toBe("Test API");
		expect(ev("SPEC.info.version")).toBe("1.0");
		expect((ev('spec["info"]') as { title: string }).title).toBe("Test API");
		expect((ev("spec") as { info: { title: string } }).info.title).toBe("Test API");
	});
});

describe("evaluateSafeExpression › member chains & array methods", () => {
	it("intercepts .length() and .slice() on helper results", () => {
		expect(ev("listTags().length()")).toBe(2);
		expect(ev('searchPaths("", 10).slice(0, 1)')).toHaveLength(1);
	});
	it("map / filter / find with arrow callbacks", () => {
		expect(ev('searchPaths("", 10).map(op => op.path)')).toEqual(["/studies", "/studies", "/health"]);
		expect(ev('searchPaths("", 10).filter(op => op.method === "get")')).toHaveLength(2);
		expect((ev('searchPaths("", 10).find(op => op.method === "post")') as { operationId: string }).operationId).toBe(
			"createStudy",
		);
	});
	it("optional chaining via . and ?.[] after a call", () => {
		expect(ev('getOperation("getStudies")?.path')).toBe("/studies");
		expect(ev('getOperation("nope")?.path')).toBe(undefined);
		expect(ev('getOperation("getStudies")?.["method"]')).toBe("get");
	});
});

describe("evaluateSafeExpression › unsupported expressions throw", () => {
	it.each([
		["unknown helper call", "evilHelper()"],
		["Object.entries on null", "Object.entries(null)"],
		["Object.entries with two args", 'Object.entries(spec.info, "x")'],
		["bare unknown identifier", "randomThing"],
		["unknown array method", 'searchPaths("x").reverse()'],
		["spec lookup with optional chaining", "spec.info?.title"],
		["unknown dotted callee", "foo.bar.baz()"],
	])("throws on %s", (_label, code) => {
		expect(() => ev(code)).toThrow();
	});
});

describe("evaluateCallbackExpression", () => {
	it("returns undefined for empty / empty-parens source", () => {
		expect(cb("")).toBe(undefined);
		expect(cb("()")).toBe(undefined);
	});
	it("evaluates object literals (full + shorthand)", () => {
		expect(cb("{ a: 1, b: x }", { x: 5 })).toEqual({ a: 1, b: 5 });
		expect(cb("{ x }", { x: 7 })).toEqual({ x: 7 });
	});
	it("nullish / or / and (both arms)", () => {
		expect(cb("a ?? 9", { a: null })).toBe(9);
		expect(cb("a ?? 9", { a: 3 })).toBe(3);
		expect(cb("a || 9", { a: 0 })).toBe(9);
		expect(cb("a || 9", { a: 3 })).toBe(3);
		expect(cb("a && 9", { a: 0 })).toBe(0);
		expect(cb("a && 9", { a: 1 })).toBe(9);
	});
	it("equality / relational operators", () => {
		expect(cb("a === 1", { a: 1 })).toBe(true);
		expect(cb("a !== 2", { a: 1 })).toBe(true);
		expect(cb("a == 1", { a: 1 })).toBe(true);
		expect(cb("a != 2", { a: 1 })).toBe(true);
		expect(cb("a >= 2", { a: 2 })).toBe(true);
		expect(cb("a <= 2", { a: 1 })).toBe(true);
		expect(cb("a > 1", { a: 2 })).toBe(true);
		expect(cb("a < 2", { a: 1 })).toBe(true);
	});
	it("additive / multiplicative (numbers + string concat)", () => {
		expect(cb("a + b", { a: 1, b: 2 })).toBe(3);
		expect(cb("a + b", { a: "x", b: "y" })).toBe("xy");
		expect(cb("a - b", { a: 5, b: 2 })).toBe(3);
		expect(cb("a * b", { a: 2, b: 3 })).toBe(6);
		expect(cb("a / b", { a: 6, b: 2 })).toBe(3);
	});
	it("string methods includes / startsWith / endsWith", () => {
		expect(cb('s.includes("at")', { s: "cat" })).toBe(true);
		expect(cb('s.startsWith("c")', { s: "cat" })).toBe(true);
		expect(cb('s.endsWith("t")', { s: "cat" })).toBe(true);
	});
	it("primitive literals", () => {
		expect(cb('"hi"')).toBe("hi");
		expect(cb("true")).toBe(true);
		expect(cb("false")).toBe(false);
		expect(cb("null")).toBe(null);
		expect(cb("undefined")).toBe(undefined);
		expect(cb("42")).toBe(42);
	});
	it("member access from scope (root + nested)", () => {
		expect(cb("x", { x: 5 })).toBe(5);
		expect(cb("obj.a.b", { obj: { a: { b: 7 } } })).toBe(7);
	});
	it("splits at the first operator → right-associative (behavior guard)", () => {
		expect(cb("10 - 3 - 2")).toBe(9);
	});
	it.each([
		["null receiver method", 'n.includes("a")', { n: null }],
		["callee with no dot", 'noDot("a")', {}],
		["unknown string method", "s.toUpperCase()", { s: "x" }],
	])("throws on %s", (_label, src, scope) => {
		expect(() => cb(src, scope as Record<string, unknown>)).toThrow();
	});
});
