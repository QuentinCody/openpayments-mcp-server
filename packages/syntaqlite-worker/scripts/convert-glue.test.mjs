import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

describe("convert-glue prerequisites", () => {
	it("source glue JS exists", () => {
		const inputPath = resolve(pkgRoot, "wasm/syntaqlite-runtime.js");
		expect(existsSync(inputPath)).toBe(true);
	});

	it("source glue JS contains the Module declaration to replace", () => {
		const inputPath = resolve(pkgRoot, "wasm/syntaqlite-runtime.js");
		const source = readFileSync(inputPath, "utf-8");
		expect(source).toContain(
			"var Module = typeof Module != 'undefined' ? Module : {};",
		);
	});

	it("source glue JS contains _scriptName guard target", () => {
		const inputPath = resolve(pkgRoot, "wasm/syntaqlite-runtime.js");
		const source = readFileSync(inputPath, "utf-8");
		expect(source).toContain("document.currentScript");
	});
});
