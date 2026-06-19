import { describe, expect, it } from "vitest";
import { buildSparqlProxySource } from "./sparql-proxy";

describe("buildSparqlProxySource", () => {
	it("emits a non-trivial source string with the injected SPARQL helpers", () => {
		const src = buildSparqlProxySource();
		expect(typeof src).toBe("string");
		expect(src.length).toBeGreaterThan(500);
		for (const marker of ["__wrapStaged", "__stageData", "__stagedResults"]) {
			expect(src).toContain(marker);
		}
	});

	it("is deterministic", () => {
		expect(buildSparqlProxySource()).toBe(buildSparqlProxySource());
	});
});
