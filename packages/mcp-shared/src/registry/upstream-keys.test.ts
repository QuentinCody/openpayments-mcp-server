import { describe, expect, it } from "vitest";
import { getRequestCorrelation, getRequestUpstreamKeys, nestedCallMeta, UPSTREAM_KEYS_META_KEY } from "./request-scope";

const KEY = "0123456789abcdef0123456789abcdef0123";

/**
 * The caller's upstream keys travel: paid orchestrator -> `params._meta` ->
 * the fleet server. Only well-formed entries pass, and a server never copies
 * them into the metadata of its own nested calls.
 */
describe("upstream keys in request metadata", () => {
	it("reads well-formed keys from either metadata location", () => {
		expect(getRequestUpstreamKeys({ _meta: { [UPSTREAM_KEYS_META_KEY]: { ncbi: KEY } } })).toEqual({ ncbi: KEY });
		expect(getRequestUpstreamKeys({ mcpReq: { _meta: { [UPSTREAM_KEYS_META_KEY]: { ncbi: KEY } } } })).toEqual({ ncbi: KEY });
	});

	it("drops malformed source names and keys, and keeps the rest", () => {
		const keys = getRequestUpstreamKeys({
			_meta: {
				[UPSTREAM_KEYS_META_KEY]: {
					ncbi: KEY,
					NCBI: KEY,
					"x y": KEY,
					short: "abc",
					spaced: "abc def ghi jkl",
					injected: "abcdefgh&api_key=other",
					number: 12345678,
				},
			},
		});
		expect(keys).toEqual({ ncbi: KEY });
	});

	it("reads at most eight entries", () => {
		const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`source-${index}`, KEY]));
		expect(Object.keys(getRequestUpstreamKeys({ _meta: { [UPSTREAM_KEYS_META_KEY]: many } }) ?? {})).toHaveLength(8);
	});

	it("is undefined for a missing, empty or wrong-shaped value", () => {
		for (const value of [undefined, null, "key", [KEY], {}, { ncbi: "" }]) {
			expect(getRequestUpstreamKeys({ _meta: { [UPSTREAM_KEYS_META_KEY]: value } })).toBeUndefined();
		}
		expect(getRequestUpstreamKeys(undefined)).toBeUndefined();
	});

	it("is not part of the correlation that a server copies to its nested calls", () => {
		expect(getRequestCorrelation({ _meta: { [UPSTREAM_KEYS_META_KEY]: { ncbi: KEY } } })).toBeUndefined();
	});

	it("is written into a nested call only when the context names it", () => {
		expect(nestedCallMeta({ upstreamKeys: { ncbi: KEY } })).toEqual({ [UPSTREAM_KEYS_META_KEY]: { ncbi: KEY } });
		expect(nestedCallMeta({ upstreamKeys: {}, chatId: "c1" })).not.toHaveProperty(UPSTREAM_KEYS_META_KEY);
		expect(nestedCallMeta({ chatId: "c1" })).not.toHaveProperty(UPSTREAM_KEYS_META_KEY);
		expect(nestedCallMeta(undefined)).toBeUndefined();
	});
});
