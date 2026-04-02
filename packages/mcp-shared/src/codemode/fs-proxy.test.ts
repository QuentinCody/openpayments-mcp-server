/**
 * Tests for fs-proxy — validates the generated JS source string.
 */

import { describe, it, expect } from "vitest";
import { buildFsProxySource } from "./fs-proxy";

describe("buildFsProxySource", () => {
	const source = buildFsProxySource();

	it("returns a non-empty string", () => {
		expect(typeof source).toBe("string");
		expect(source.length).toBeGreaterThan(0);
	});

	it("defines an fs object", () => {
		expect(source).toContain("var fs =");
	});

	it("includes all core fs methods", () => {
		const methods = [
			"readFile",
			"writeFile",
			"appendFile",
			"mkdir",
			"readdir",
			"stat",
			"exists",
			"rm",
			"glob",
			"readJSON",
			"writeJSON",
		];
		for (const method of methods) {
			expect(source).toContain(`${method}: async function`);
		}
	});

	it("routes through codemode.__fs_* RPC calls", () => {
		expect(source).toContain("codemode.__fs_read");
		expect(source).toContain("codemode.__fs_write");
		expect(source).toContain("codemode.__fs_append");
		expect(source).toContain("codemode.__fs_mkdir");
		expect(source).toContain("codemode.__fs_readdir");
		expect(source).toContain("codemode.__fs_stat");
		expect(source).toContain("codemode.__fs_exists");
		expect(source).toContain("codemode.__fs_rm");
		expect(source).toContain("codemode.__fs_glob");
	});

	it("auto-stringifies objects in writeFile", () => {
		expect(source).toContain('typeof content === "object"');
		expect(source).toContain("JSON.stringify(content, null, 2)");
	});

	it("readJSON parses inline without extra RPC", () => {
		expect(source).toContain("JSON.parse(content)");
	});

	it("checks for __fs_error on all methods", () => {
		// Every method should check for error responses
		const errorChecks = source.match(/__fs_error/g);
		expect(errorChecks).not.toBeNull();
		// 11 methods × 1 check each = 11 minimum
		expect(errorChecks!.length).toBeGreaterThanOrEqual(11);
	});
});
