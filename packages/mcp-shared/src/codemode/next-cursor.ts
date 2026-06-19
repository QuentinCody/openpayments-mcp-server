/**
 * Next-page cursor normalization (ADR-006 / DRF cursor pagination).
 *
 * Cursor APIs such as CourtListener (Django REST Framework) return `next` as a
 * FULL absolute URL — e.g. `https://www.courtlistener.com/api/rest/v4/search/?cursor=bz0x...`.
 * Re-sending that whole URL back as `cursor=` (URL-encoded) produces a garbage
 * cursor and breaks pagination after page 1. This helper extracts just the
 * cursor token so the next request flows through the server's own adapter
 * (preserving auth headers + base URL) instead of "following" the raw URL.
 */

/** Query-param names that commonly carry a cursor/page token inside a `next` URL. */
const URL_CURSOR_PARAMS: readonly string[] = ["cursor", "page", "offset", "after", "page_token"];

/** True when a value is genuinely URL-shaped — absolute (`scheme://…`) or a
 * root-relative path (`/path?…`). Opaque cursor tokens are not. */
function isUrlShaped(raw: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("/");
}

/**
 * Normalize a raw `next` value into the token to resend.
 *
 * - Bare token (no `?`)            → returned unchanged.
 * - URL-shaped (`...?cursor=ABC`)  → the cursor query param's value (`ABC`).
 * - URL-shaped, no known param     → returned unchanged (last resort).
 *
 * @param cursorParam the request param the caller resends the cursor as; checked
 *   first so it round-trips, then a fallback list of common token params.
 */
export function normalizeNextCursor(raw: string, cursorParam = "cursor"): string {
	const qIndex = raw.indexOf("?");
	// Only mine query params from genuinely URL-shaped values; an opaque token
	// that merely contains a "?" is returned unchanged (no false truncation).
	if (qIndex === -1 || !isUrlShaped(raw)) return raw;
	const sp = new URLSearchParams(raw.slice(qIndex + 1));
	for (const key of [cursorParam, ...URL_CURSOR_PARAMS]) {
		const v = sp.get(key);
		if (v) return v;
	}
	return raw; // URL-shaped but no recognizable cursor param — return as-is
}
