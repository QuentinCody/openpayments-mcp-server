/**
 * Passthrough transport-size guards.
 *
 * MCP Streamable HTTP silently DROPS a `structuredContent` payload over ~100 KB
 * (CLAUDE.md "structuredContent Transport Limit"). When a hidden passthrough
 * (`__api_proxy` / `__graphql_proxy`) returns oversized data — or, worse, an
 * oversized ERROR body — inline, the payload vanishes and the failure with it.
 * These helpers size a value cheaply so the proxies can fail LOUDLY (a small
 * `__api_error` / `__gql_error` that tells the caller to narrow) instead of
 * dropping the answer on the floor.
 */

/** MCP Streamable HTTP drops a structuredContent payload above this many bytes. */
export const TRANSPORT_LIMIT = 100_000;

/**
 * UTF-8 byte length of a string WITHOUT allocating (Workers have no `Buffer`,
 * and `TextEncoder().encode(s).length` allocates the whole byte array just to
 * read its length). Walks code units, adds the bytes each encodes to, and pairs
 * surrogates so an emoji counts as 4 bytes, not 2×3. A lone surrogate counts as
 * the 3-byte U+FFFD replacement — matching how a well-formed `JSON.stringify`
 * would have escaped it anyway.
 */
export function utf8Len(s: string): number {
	let bytes = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) {
			bytes += 1;
		} else if (c < 0x800) {
			bytes += 2;
		} else if (c >= 0xd800 && c <= 0xdbff) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/**
 * Byte size of a value once JSON-serialized. Returns 0 for `undefined`
 * (`JSON.stringify(undefined) === undefined`, whose `.length` would THROW — the
 * 204-no-content case that turned a success into a synthetic 500). A value that
 * cannot be serialized (circular reference, BigInt) is reported as oversized so
 * callers fail safe rather than crash.
 */
export function jsonByteSize(value: unknown): number {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		return TRANSPORT_LIMIT + 1;
	}
	return json === undefined ? 0 : utf8Len(json);
}

/** True when a value's JSON would exceed the transport limit (and be dropped). */
export function isOversized(value: unknown): boolean {
	return jsonByteSize(value) > TRANSPORT_LIMIT;
}

/**
 * Prepare an error's `data` field for inline transport. Oversized evidence is
 * never shortened or represented as a partial payload. Callers with staging
 * should stage the original value before using this fallback; callers without
 * staging receive a loud, machine-readable refusal.
 */
export function boundedErrorData(data: unknown): unknown {
	if (data === undefined) return undefined;
	const bytes = jsonByteSize(data);
	if (bytes <= TRANSPORT_LIMIT) return data;
	return {
		__lossless_error: true,
		code: "LOSSLESS_STAGING_REQUIRED",
		evidence_returned: false,
		observed_bytes: bytes,
		message:
			`The upstream error evidence is ${bytes} bytes, over the ${TRANSPORT_LIMIT}-byte inline limit. ` +
			"No partial evidence was returned; configure staging to retrieve the exact body.",
	};
}
