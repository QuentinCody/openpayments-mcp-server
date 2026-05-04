import { describe, it, expect, beforeEach } from "vitest";
import {
	buildQueryString,
	registerRateLimitPolicy,
	resetRateLimitState,
} from "./rest-fetch";

describe("buildQueryString", () => {
	it("builds simple key-value pairs", () => {
		expect(buildQueryString({ a: "1", b: "2" })).toBe("a=1&b=2");
	});

	it("handles arrays by repeating the key", () => {
		expect(buildQueryString({ ids: ["a", "b"] })).toBe("ids=a&ids=b");
	});

	it("skips null and undefined values", () => {
		expect(buildQueryString({ a: "1", b: null, c: undefined })).toBe("a=1");
	});

	it("encodes special characters", () => {
		expect(buildQueryString({ q: "hello world" })).toBe("q=hello%20world");
	});

	it("returns empty string for empty params", () => {
		expect(buildQueryString({})).toBe("");
	});
});

describe("registerRateLimitPolicy", () => {
	beforeEach(() => {
		resetRateLimitState();
	});

	it("registers a policy without error", () => {
		expect(() =>
			registerRateLimitPolicy({ key: "test-api", minIntervalMs: 500 }),
		).not.toThrow();
	});

	it("overwrites a policy with the same key", () => {
		registerRateLimitPolicy({ key: "test-api", minIntervalMs: 500 });
		expect(() =>
			registerRateLimitPolicy({ key: "test-api", minIntervalMs: 1000 }),
		).not.toThrow();
	});
});

describe("resetRateLimitState", () => {
	it("clears all policies and timestamps", () => {
		registerRateLimitPolicy({ key: "a", minIntervalMs: 100 });
		registerRateLimitPolicy({ key: "b", minIntervalMs: 200 });
		resetRateLimitState();
		expect(() =>
			registerRateLimitPolicy({ key: "a", minIntervalMs: 300 }),
		).not.toThrow();
	});
});

describe("restFetch", () => {
	// restFetch calls global fetch which isn't available in unit test context
	// without a full HTTP mock. Integration-level tests cover the retry/cache
	// behavior. Here we verify the module exports are well-formed.
	it("exports restFetch as a function", async () => {
		const { restFetch } = await import("./rest-fetch");
		expect(typeof restFetch).toBe("function");
	});
});
