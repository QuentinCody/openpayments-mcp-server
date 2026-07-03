import { describe, expect, it } from "vitest";
import { wrapInUserScope } from "./user-scope";

/** Build + run an async program string, returning its resolved value. */
function runProgram(body: string): Promise<unknown> {
	const factory = new Function(
		`return (async () => { ${body} })();`,
	) as () => Promise<unknown>;
	return factory();
}

describe("wrapInUserScope (T4.2)", () => {
	it("nests user code in an async IIFE so it runs in its own lexical scope", () => {
		const wrapped = wrapInUserScope("const api = 1;\nreturn api;");
		expect(wrapped).toContain("return await (async () => {");
		expect(wrapped).toContain("const api = 1;");
		expect(wrapped).toContain("})();");
	});

	it("lets a user `const api`/`const schema` shadow the injected helpers instead of colliding", () => {
		// Simulate the injected-helper + user-code layout: outer `var api`/`var schema`
		// (the injected helpers) followed by the nested user scope that redeclares them.
		const source = `var api = { get: () => "outer" }; var schema = {};\n${wrapInUserScope(
			'const api = { get: () => "user" }; const schema = 42; return api.get() + ":" + schema;',
		)}`;
		return expect(runProgram(source)).resolves.toBe("user:42");
	});

	it("propagates the user's return value out of the nested scope", () => {
		return expect(runProgram(wrapInUserScope("return 7 * 6;"))).resolves.toBe(
			42,
		);
	});
});
