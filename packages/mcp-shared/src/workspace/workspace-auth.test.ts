import { describe, expect, it } from "vitest";
import { isWorkspaceRequestAuthorized, timingSafeEqual } from "./workspace-auth";

/** A header reader backed by a plain (lowercased) map, like Request.headers. */
const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

describe("timingSafeEqual", () => {
	it("returns true for equal strings", () => {
		expect(timingSafeEqual("abc123", "abc123")).toBe(true);
	});
	it("returns false for equal-length but different strings", () => {
		expect(timingSafeEqual("abc123", "abc124")).toBe(false);
	});
	it("returns false for different-length strings", () => {
		expect(timingSafeEqual("abc", "abcdef")).toBe(false);
	});
	it("returns true for two empty strings", () => {
		expect(timingSafeEqual("", "")).toBe(true);
	});
});

describe("isWorkspaceRequestAuthorized", () => {
	it("fails closed when the expected token is unset or empty", () => {
		expect(isWorkspaceRequestAuthorized(headers({ authorization: "Bearer x" }), undefined)).toBe(false);
		expect(isWorkspaceRequestAuthorized(headers({ authorization: "Bearer x" }), "")).toBe(false);
	});
	it("accepts a correct Authorization: Bearer token", () => {
		expect(isWorkspaceRequestAuthorized(headers({ authorization: "Bearer s3cret" }), "s3cret")).toBe(true);
	});
	it("accepts a correct x-workspace-token header", () => {
		expect(isWorkspaceRequestAuthorized(headers({ "x-workspace-token": "s3cret" }), "s3cret")).toBe(true);
	});
	it("rejects a wrong token", () => {
		expect(isWorkspaceRequestAuthorized(headers({ authorization: "Bearer nope" }), "s3cret")).toBe(false);
	});
	it("rejects when no credential header is present", () => {
		expect(isWorkspaceRequestAuthorized(headers({}), "s3cret")).toBe(false);
	});
	it("rejects a non-Bearer Authorization scheme with no fallback header", () => {
		expect(isWorkspaceRequestAuthorized(headers({ authorization: "Basic abc" }), "s3cret")).toBe(false);
	});
});
