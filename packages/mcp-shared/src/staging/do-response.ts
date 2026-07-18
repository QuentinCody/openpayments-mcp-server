/**
 * Robust JSON parsing for Durable Object responses.
 *
 * Extracted from ./utils.ts (at the line cap). Reads the body as TEXT first so
 * an empty or non-JSON body — a 200 with no body, or a Cloudflare edge HTML 5xx
 * page — reaches the caller's fallback (e.g. "Empty response from DO") instead
 * of throwing a raw `Unexpected end of JSON input` SyntaxError that masks the
 * real DO failure (hardening doc 10, Finding 2).
 */

/**
 * Safely parse a DO Response body as JSON, returning `fallback` for an empty,
 * non-JSON, or non-object body. Never throws on a malformed body.
 */
export async function parseJsonResponse<T>(
	resp: Response,
	fallback: T,
): Promise<T> {
	let raw: unknown;
	try {
		const text = await resp.text();
		raw = text.trim() ? JSON.parse(text) : null;
	} catch {
		return fallback;
	}
	return raw !== null && typeof raw === "object" ? (raw as T) : fallback;
}
