import { describe, expect, it } from "vitest";
import {
	boundedErrorData,
	CODE_MODE_LOG_LIMIT_BYTES,
	isOversized,
	jsonByteSize,
	STAGING_THRESHOLD_BYTES,
	TRANSPORT_LIMIT,
	truncateUtf8,
	utf8Len,
} from "./passthrough-limits";

describe("utf8Len", () => {
	it("counts ASCII as one byte each", () => {
		expect(utf8Len("hello")).toBe(5);
		expect(utf8Len("")).toBe(0);
	});

	it("counts 2- and 3-byte code points", () => {
		expect(utf8Len("é")).toBe(2); // U+00E9
		expect(utf8Len("中")).toBe(3); // U+4E2D
	});

	it("counts a surrogate pair as 4 bytes, not 2×3", () => {
		expect(utf8Len("😀")).toBe(4); // U+1F600
		expect(utf8Len("A😀B")).toBe(6);
	});

	it("counts a lone high surrogate as the 3-byte replacement", () => {
		expect(utf8Len("\ud83d")).toBe(3);
	});

	it("agrees with TextEncoder over a mixed string", () => {
		const s = 'a"é中😀\n\\';
		expect(utf8Len(s)).toBe(new TextEncoder().encode(s).length);
	});
});

describe("truncateUtf8", () => {
	it("keeps emoji and CJK code points whole at byte boundaries", () => {
		expect(truncateUtf8("A😀中B", 5)).toBe("A😀");
		expect(truncateUtf8("A😀中B", 8)).toBe("A😀中");
	});

	it("handles zero budgets and strings already within budget", () => {
		expect(truncateUtf8("😀", 0)).toBe("");
		expect(truncateUtf8("中", 3)).toBe("中");
	});
});

describe("shared byte limits", () => {
	it("uses one 30KB staging threshold, 100KB transport cap, and bounded log budget", () => {
		expect(STAGING_THRESHOLD_BYTES).toBe(30 * 1024);
		expect(TRANSPORT_LIMIT).toBe(100_000);
		expect(CODE_MODE_LOG_LIMIT_BYTES).toBeLessThan(STAGING_THRESHOLD_BYTES);
	});
});

describe("jsonByteSize", () => {
	it("returns 0 for undefined (the 204-no-content case, must not throw)", () => {
		expect(jsonByteSize(undefined)).toBe(0);
	});

	it("sizes the JSON of a value, UTF-8 accurate", () => {
		// JSON.stringify({a:"é"}) === '{"a":"é"}' — 'é' is 2 bytes.
		expect(jsonByteSize({ a: "é" })).toBe(new TextEncoder().encode('{"a":"é"}').length);
	});

	it("does not undercount emoji or CJK near fleet thresholds", () => {
		const emoji = { text: "😀".repeat(8_000) };
		const cjk = { text: "中".repeat(11_000) };
		expect(jsonByteSize(emoji)).toBe(
			new TextEncoder().encode(JSON.stringify(emoji)).length,
		);
		expect(jsonByteSize(cjk)).toBe(
			new TextEncoder().encode(JSON.stringify(cjk)).length,
		);
		expect(jsonByteSize(emoji)).toBeGreaterThan(STAGING_THRESHOLD_BYTES);
		expect(jsonByteSize(cjk)).toBeGreaterThan(STAGING_THRESHOLD_BYTES);
	});

	it("treats an unserializable value as oversized (fail safe)", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(jsonByteSize(circular)).toBe(TRANSPORT_LIMIT + 1);
		expect(jsonByteSize(BigInt(1))).toBe(TRANSPORT_LIMIT + 1);
	});
});

describe("isOversized", () => {
	it("is false at and below the limit, true just above", () => {
		// A JSON string of exactly TRANSPORT_LIMIT bytes: "<...>" with padding.
		const atLimit = "x".repeat(TRANSPORT_LIMIT - 2); // + 2 quotes = TRANSPORT_LIMIT
		expect(jsonByteSize(atLimit)).toBe(TRANSPORT_LIMIT);
		expect(isOversized(atLimit)).toBe(false);
		expect(isOversized("x".repeat(TRANSPORT_LIMIT - 1))).toBe(true);
	});

	it("is false for undefined and small values", () => {
		expect(isOversized(undefined)).toBe(false);
		expect(isOversized({ ok: true })).toBe(false);
	});
});

describe("boundedErrorData", () => {
	it("passes undefined and small bodies through untouched", () => {
		expect(boundedErrorData(undefined)).toBeUndefined();
		const small = { error: "not found" };
		expect(boundedErrorData(small)).toBe(small);
	});

	it("fails loud for an oversized body without representing a partial payload", () => {
		const big = { blob: "x".repeat(TRANSPORT_LIMIT + 10) };
		const bounded = boundedErrorData(big) as Record<string, unknown>;
		expect(bounded).toMatchObject({
			__lossless_error: true,
			code: "LOSSLESS_STAGING_REQUIRED",
			evidence_returned: false,
		});
		expect(bounded).not.toHaveProperty("__truncated");
		expect(isOversized(bounded)).toBe(false);
	});
});
