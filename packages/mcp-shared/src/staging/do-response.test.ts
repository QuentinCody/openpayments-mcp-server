import { describe, expect, it } from "vitest";
import { parseJsonResponse } from "./do-response";

const res = (body: string, status = 200) =>
	new Response(body, {
		status,
		headers: { "content-type": "application/json" },
	});

describe("parseJsonResponse", () => {
	const fallback = { success: false, error: "Empty response from DO" };

	it("parses a well-formed JSON object body", async () => {
		const r = await parseJsonResponse(res('{"success":true,"n":3}'), fallback);
		expect(r).toEqual({ success: true, n: 3 });
	});

	it("returns the fallback for an EMPTY body instead of throwing (doc 10)", async () => {
		// resp.json() would throw 'Unexpected end of JSON input' on these.
		expect(await parseJsonResponse(res(""), fallback)).toBe(fallback);
		expect(await parseJsonResponse(res("   "), fallback)).toBe(fallback);
	});

	it("returns the fallback for a non-JSON body (a Cloudflare edge HTML 5xx)", async () => {
		expect(
			await parseJsonResponse(res("<html>502 Bad Gateway</html>", 502), fallback),
		).toBe(fallback);
	});

	it("returns the fallback for a JSON body that is not an object", async () => {
		expect(await parseJsonResponse(res("42"), fallback)).toBe(fallback);
		expect(await parseJsonResponse(res("null"), fallback)).toBe(fallback);
		expect(await parseJsonResponse(res('"a string"'), fallback)).toBe(fallback);
	});

	it("returns an array body as-is (arrays are objects)", async () => {
		const r = await parseJsonResponse(res("[1,2,3]"), fallback);
		expect(r).toEqual([1, 2, 3]);
	});
});
