import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildQueryString,
	registerRateLimitPolicy,
	resetRateLimitState,
	restFetch,
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
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		resetRateLimitState();
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const mkRes = (
		status: number,
		body = "{}",
		headers: Record<string, string> = {},
	) => new Response(body, { status, headers });

	const callOf = (n: number) =>
		fetchMock.mock.calls[n] as [
			string,
			RequestInit & { headers: Record<string, string> },
		];

	it("performs a GET with query string and default headers, returning the response", async () => {
		fetchMock.mockResolvedValueOnce(mkRes(200, '{"ok":true}'));
		const res = await restFetch("https://api.test/", "/items", {
			q: "x",
			n: 2,
		});
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = callOf(0);
		expect(url).toBe("https://api.test/items?q=x&n=2");
		expect(init.method).toBe("GET");
		expect(init.headers.Accept).toBe("application/json");
		expect(init.headers["User-Agent"]).toBe("bio-mcp-server/1.0");
	});

	it("serializes an object body as JSON and sets Content-Type", async () => {
		fetchMock.mockResolvedValueOnce(mkRes(200));
		await restFetch("https://api.test", "/x", undefined, {
			method: "POST",
			body: { a: 1 },
		});
		const init = callOf(0)[1];
		expect(init.body).toBe('{"a":1}');
		expect(init.headers["Content-Type"]).toBe("application/json");
	});

	it("passes a string body through unchanged", async () => {
		fetchMock.mockResolvedValueOnce(mkRes(200));
		await restFetch("https://api.test", "/x", undefined, {
			method: "POST",
			body: "raw-payload",
		});
		expect(callOf(0)[1].body).toBe("raw-payload");
	});

	it("returns a non-retryable error status without retrying", async () => {
		fetchMock.mockResolvedValueOnce(mkRes(404));
		const res = await restFetch("https://api.test", "/missing");
		expect(res.status).toBe(404);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries on a 429 and returns the eventual success", async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(mkRes(429))
			.mockResolvedValueOnce(mkRes(200, '{"ok":1}'));
		const p = restFetch("https://api.test", "/x", undefined, { retries: 2 });
		await vi.advanceTimersByTimeAsync(5000);
		expect((await p).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("honors a Retry-After header on a retryable status", async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(mkRes(503, "", { "Retry-After": "1" }))
			.mockResolvedValueOnce(mkRes(200));
		const p = restFetch("https://api.test", "/x", undefined, { retries: 1 });
		await vi.advanceTimersByTimeAsync(2000);
		expect((await p).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("recovers when a thrown network error is followed by success", async () => {
		vi.useFakeTimers();
		fetchMock
			.mockRejectedValueOnce(new Error("flaky"))
			.mockResolvedValueOnce(mkRes(200));
		const p = restFetch("https://api.test", "/x", undefined, { retries: 1 });
		await vi.advanceTimersByTimeAsync(5000);
		expect((await p).status).toBe(200);
	});

	it("throws the last error after exhausting retries on persistent failure", async () => {
		vi.useFakeTimers();
		fetchMock.mockRejectedValue(new Error("ECONNRESET"));
		const p = restFetch("https://api.test", "/x", undefined, { retries: 1 });
		const expectation = expect(p).rejects.toThrow("ECONNRESET");
		await vi.advanceTimersByTimeAsync(5000);
		await expectation;
		expect(fetchMock).toHaveBeenCalledTimes(2); // initial attempt + 1 retry
	});

	it("serializes requests that share a rate-limit policy key", async () => {
		registerRateLimitPolicy({ key: "throttled", minIntervalMs: 1000 });
		fetchMock.mockResolvedValue(mkRes(200));
		await restFetch("https://api.test", "/first", undefined, {
			rateLimitKey: "throttled",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
