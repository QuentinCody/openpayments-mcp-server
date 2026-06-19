import { describe, expect, it } from "vitest";
import { normalizeNextCursor } from "./next-cursor";

describe("normalizeNextCursor", () => {
	it("extracts the cursor param from a full absolute URL (DRF)", () => {
		expect(
			normalizeNextCursor("https://www.courtlistener.com/api/rest/v4/search/?cursor=bz0xJmw9MA%3D%3D&type=r"),
		).toBe("bz0xJmw9MA=="); // %3D%3D decodes to == via URLSearchParams
	});

	it("extracts the cursor from a relative URL (no scheme)", () => {
		expect(normalizeNextCursor("/api/rest/v4/search/?cursor=REL123&type=r")).toBe("REL123");
	});

	it("returns a bare token unchanged (no query string)", () => {
		expect(normalizeNextCursor("PLAIN_TOKEN")).toBe("PLAIN_TOKEN");
	});

	it("honors a non-default cursorParam", () => {
		expect(normalizeNextCursor("https://api.example.com/items/?page=3", "page")).toBe("3");
	});

	it("prefers the explicit cursorParam, then falls back to common token params", () => {
		expect(normalizeNextCursor("https://api.example.com/items/?cursor=ABC&page=3")).toBe("ABC");
		expect(normalizeNextCursor("https://api.example.com/items/?page=3")).toBe("3");
	});

	it("returns the raw value when URL-shaped but no recognizable cursor param", () => {
		expect(normalizeNextCursor("https://api.example.com/items/?foo=bar")).toBe(
			"https://api.example.com/items/?foo=bar",
		);
	});

	it("returns an opaque token that merely contains a \"?\" unchanged (not URL-shaped)", () => {
		expect(normalizeNextCursor("abc?cursor=XYZ")).toBe("abc?cursor=XYZ");
		expect(normalizeNextCursor("DXF1ZXJ5?after=evil")).toBe("DXF1ZXJ5?after=evil");
	});
});
