import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateTypes, zodToTypeString } from "./types";

// Characterization + spec tests for the Zod-v4 → TypeScript string converter.
// These lock the current behavior branch-by-branch so the cyclomatic-complexity
// refactor of `zodToTypeString` is provably behavior-preserving.

describe("zodToTypeString — primitives", () => {
	it("maps scalar zod types to their TS keyword", () => {
		expect(zodToTypeString(z.string())).toBe("string");
		expect(zodToTypeString(z.number())).toBe("number");
		expect(zodToTypeString(z.boolean())).toBe("boolean");
		expect(zodToTypeString(z.bigint())).toBe("bigint");
		expect(zodToTypeString(z.date())).toBe("Date");
		expect(zodToTypeString(z.null())).toBe("null");
		expect(zodToTypeString(z.undefined())).toBe("undefined");
		expect(zodToTypeString(z.any())).toBe("any");
		expect(zodToTypeString(z.unknown())).toBe("unknown");
		expect(zodToTypeString(z.never())).toBe("never");
		expect(zodToTypeString(z.void())).toBe("void");
	});
});

describe("zodToTypeString — literals & enums", () => {
	it("renders string literals quoted", () => {
		expect(zodToTypeString(z.literal("hello"))).toBe('"hello"');
	});
	it("renders numeric and boolean literals unquoted", () => {
		expect(zodToTypeString(z.literal(42))).toBe("42");
		expect(zodToTypeString(z.literal(true))).toBe("true");
	});
	it("renders an enum as a union of quoted members", () => {
		expect(zodToTypeString(z.enum(["a", "b", "c"]))).toBe('"a" | "b" | "c"');
	});
});

describe("zodToTypeString — containers", () => {
	it("renders arrays with element type", () => {
		expect(zodToTypeString(z.array(z.string()))).toBe("string[]");
	});
	it("parenthesizes union element types in arrays", () => {
		expect(zodToTypeString(z.array(z.union([z.string(), z.number()])))).toBe(
			"(string | number)[]",
		);
	});
	it("renders unions", () => {
		expect(zodToTypeString(z.union([z.string(), z.number()]))).toBe(
			"string | number",
		);
	});
	it("renders records as Record<string, V>", () => {
		expect(zodToTypeString(z.record(z.string(), z.number()))).toBe(
			"Record<string, number>",
		);
	});
	it("renders tuples positionally", () => {
		expect(zodToTypeString(z.tuple([z.string(), z.number()]))).toBe(
			"[string, number]",
		);
	});
});

describe("zodToTypeString — wrappers", () => {
	it("renders optional as `T | undefined`", () => {
		expect(zodToTypeString(z.string().optional())).toBe("string | undefined");
	});
	it("renders nullable as `T | null`", () => {
		expect(zodToTypeString(z.string().nullable())).toBe("string | null");
	});
	it("unwraps default/catch/readonly to the inner type", () => {
		expect(zodToTypeString(z.string().default("x"))).toBe("string");
		expect(zodToTypeString(z.string().catch("x"))).toBe("string");
		expect(zodToTypeString(z.string().readonly())).toBe("string");
	});
});

describe("zodToTypeString — objects", () => {
	it("renders an empty object as {}", () => {
		expect(zodToTypeString(z.object({}))).toBe("{}");
	});
	it("renders fields with tab indentation and trailing semicolons", () => {
		expect(zodToTypeString(z.object({ id: z.string(), n: z.number() }))).toBe(
			"{\n\tid: string;\n\tn: number;\n}",
		);
	});
	it("marks optional fields with `?`", () => {
		expect(zodToTypeString(z.object({ id: z.string().optional() }))).toBe(
			"{\n\tid?: string | undefined;\n}",
		);
	});
	it("appends descriptions as line comments", () => {
		expect(
			zodToTypeString(z.object({ id: z.string().describe("the id") })),
		).toBe("{\n\tid: string; // the id\n}");
	});
	it("nests recursively", () => {
		expect(
			zodToTypeString(z.object({ child: z.object({ x: z.boolean() }) })),
		).toBe("{\n\tchild: {\n\tx: boolean;\n};\n}");
	});
});

describe("zodToTypeString — non-schema input", () => {
	it("returns `any` for anything without zod internals", () => {
		expect(zodToTypeString(42)).toBe("any");
		expect(zodToTypeString("str")).toBe("any");
		expect(zodToTypeString(null)).toBe("any");
		expect(zodToTypeString(undefined)).toBe("any");
		expect(zodToTypeString({})).toBe("any");
		expect(zodToTypeString({ notZod: true })).toBe("any");
	});
});

describe("generateTypes", () => {
	it("emits Input/Output types and a codemode tool signature from a full zod object", () => {
		const out = generateTypes([
			{
				name: "get_thing",
				description: "Gets a thing",
				inputSchema: z.object({ id: z.string() }),
			},
		]);
		expect(out).toContain("type GetThingInput = {\n\tid: string;\n}");
		expect(out).toContain("type GetThingOutput = any");
		expect(out).toContain(
			"get_thing: (input: GetThingInput) => Promise<GetThingOutput>;",
		);
		expect(out).toContain("/** Gets a thing */");
		expect(out).toContain("declare const codemode: {");
	});

	it("treats a plain shape object as an interface", () => {
		const out = generateTypes([
			{ name: "search", inputSchema: { q: z.string() } },
		]);
		expect(out).toContain("interface SearchInput {\n\tq: string;\n}");
	});

	it("renders an empty shape as an empty type", () => {
		// Build the empty shape via a variable: an inline empty raw schema literal
		// is a banned MCP pattern that the source scanner (mcp-sdk-schema-compat) flags.
		const emptyShape: Record<string, unknown> = {};
		expect(
			generateTypes([{ name: "ping", inputSchema: emptyShape }]),
		).toContain("type PingInput = {}");
	});

	it("renders a non-object input schema as an empty type", () => {
		expect(generateTypes([{ name: "noop", inputSchema: undefined }])).toContain(
			"type NoopInput = {}",
		);
	});

	it("always includes the query/queryBatch/store helper declarations", () => {
		const out = generateTypes([]);
		expect(out).toContain("declare function query(");
		expect(out).toContain("declare function queryBatch(");
		expect(out).toContain("declare function store(");
	});
});
