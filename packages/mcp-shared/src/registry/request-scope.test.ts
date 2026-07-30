import { describe, expect, it } from "vitest";
import {
	CHAT_SCOPE_META_KEY,
	childTraceparent,
	getRequestCorrelation,
	getRequestScope,
	getRequestTraceparent,
	type MaybeExtra,
	nestedCallMeta,
	TRACEPARENT_META_KEY,
} from "./request-scope";

const TRACEPARENT = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

describe("getRequestScope", () => {
	it("returns undefined for undefined input", () => {
		expect(getRequestScope(undefined)).toBeUndefined();
	});

	it("returns undefined for null-ish source", () => {
		expect(getRequestScope(undefined)).toBeUndefined();
	});

	it("returns the string as-is when source is a non-empty string", () => {
		expect(getRequestScope("session-abc")).toBe("session-abc");
	});

	it("returns undefined for an empty string", () => {
		expect(getRequestScope("")).toBeUndefined();
	});

	it("uses a reverse-DNS prefixed _meta key, not a bare generic name", () => {
		expect(CHAT_SCOPE_META_KEY).toBe("dev.quentincody.bio/chatId");
		// The MCP spec reserves prefixes whose SECOND label is `mcp` or
		// `modelcontextprotocol`. Ours must not collide with that reservation.
		const secondLabel = CHAT_SCOPE_META_KEY.split("/")[0].split(".")[1];
		expect(["mcp", "modelcontextprotocol"]).not.toContain(secondLabel);
	});

	it("reads the _meta chat-scope key when present", () => {
		const extra: MaybeExtra = {
			_meta: { [CHAT_SCOPE_META_KEY]: "chat-1" },
		};
		expect(getRequestScope(extra)).toBe("chat-1");
	});

	it("reads MCP SDK v2 request metadata before compatibility metadata", () => {
		const extra: MaybeExtra = {
			mcpReq: { _meta: { [CHAT_SCOPE_META_KEY]: "v2-chat" } },
			_meta: { [CHAT_SCOPE_META_KEY]: "legacy-chat" },
		};
		expect(getRequestScope(extra)).toBe("v2-chat");
	});

	it("reads the MCP SDK v2 HTTP request header", () => {
		const extra: MaybeExtra = {
			http: {
				req: new Request("https://example.test/mcp", {
					headers: { "mcp-chat-id": "v2-header-chat" },
				}),
			},
		};
		expect(getRequestScope(extra)).toBe("v2-header-chat");
	});

	it("ignores the legacy bare _meta.app.chatId shape", () => {
		const extra = {
			_meta: { app: { chatId: "legacy" } },
			sessionId: "session-fallback",
		} as unknown as MaybeExtra;
		expect(getRequestScope(extra)).toBe("session-fallback");
	});

	it("reads requestInfo.headers['mcp-chat-id'] when no _meta", () => {
		const extra: MaybeExtra = {
			requestInfo: { headers: { "mcp-chat-id": "chat-from-header" } },
		};
		expect(getRequestScope(extra)).toBe("chat-from-header");
	});

	it("reads requestInfo.headers['Mcp-Chat-Id'] (canonical casing)", () => {
		const extra: MaybeExtra = {
			requestInfo: { headers: { "Mcp-Chat-Id": "chat-cased" } },
		};
		expect(getRequestScope(extra)).toBe("chat-cased");
	});

	it("prefers lowercase header key over canonical when both present", () => {
		const extra: MaybeExtra = {
			requestInfo: {
				headers: {
					"mcp-chat-id": "lower",
					"Mcp-Chat-Id": "canonical",
				},
			},
		};
		expect(getRequestScope(extra)).toBe("lower");
	});

	it("handles array-valued headers by taking the first element", () => {
		const extra: MaybeExtra = {
			requestInfo: {
				headers: { "mcp-chat-id": ["chat-first", "chat-second"] },
			},
		};
		expect(getRequestScope(extra)).toBe("chat-first");
	});

	it("falls through to sessionId when no _meta and no header", () => {
		const extra: MaybeExtra = { sessionId: "session-only" };
		expect(getRequestScope(extra)).toBe("session-only");
	});

	it("prioritizes _meta over header over sessionId", () => {
		const extra: MaybeExtra = {
			sessionId: "session-low",
			requestInfo: { headers: { "mcp-chat-id": "header-mid" } },
			_meta: { [CHAT_SCOPE_META_KEY]: "meta-high" },
		};
		expect(getRequestScope(extra)).toBe("meta-high");
	});

	it("prioritizes header over sessionId when _meta is absent", () => {
		const extra: MaybeExtra = {
			sessionId: "session-low",
			requestInfo: { headers: { "mcp-chat-id": "header-mid" } },
		};
		expect(getRequestScope(extra)).toBe("header-mid");
	});

	it("skips an empty _meta chat-scope key and falls through to header", () => {
		const extra: MaybeExtra = {
			_meta: { [CHAT_SCOPE_META_KEY]: "" },
			requestInfo: { headers: { "mcp-chat-id": "header-fallback" } },
		};
		expect(getRequestScope(extra)).toBe("header-fallback");
	});

	it("skips empty header value and falls through to sessionId", () => {
		const extra: MaybeExtra = {
			requestInfo: { headers: { "mcp-chat-id": "" } },
			sessionId: "session-fallback",
		};
		expect(getRequestScope(extra)).toBe("session-fallback");
	});

	it("returns undefined when extra is present but all channels are empty", () => {
		const extra: MaybeExtra = {
			_meta: { [CHAT_SCOPE_META_KEY]: "" },
			requestInfo: { headers: { "mcp-chat-id": "" } },
			sessionId: "",
		};
		expect(getRequestScope(extra)).toBeUndefined();
	});

	it("returns undefined when extra is an empty object", () => {
		expect(getRequestScope({})).toBeUndefined();
	});

	it("ignores non-string _meta chat-scope values", () => {
		const extra = {
			_meta: { [CHAT_SCOPE_META_KEY]: 123 as unknown as string },
			sessionId: "session-fallback",
		} as MaybeExtra;
		expect(getRequestScope(extra)).toBe("session-fallback");
	});

	it("ignores _meta with no chat-scope key", () => {
		const extra: MaybeExtra = {
			_meta: { otherKey: "value" },
			sessionId: "session-fallback",
		};
		expect(getRequestScope(extra)).toBe("session-fallback");
	});

	it("tolerates extra fields on MaybeExtra without breaking", () => {
		const extra: MaybeExtra = {
			sessionId: "ok",
			authInfo: { token: "redacted" },
			signal: {} as unknown,
		};
		expect(getRequestScope(extra)).toBe("ok");
	});
});

describe("request trace correlation", () => {
	it("reads MCP SDK v2 request metadata before the transport header", () => {
		const extra: MaybeExtra = {
			mcpReq: { _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT } },
			http: {
				req: new Request("https://example.test/mcp", {
					headers: {
						traceparent:
							"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
					},
				}),
			},
		};
		expect(getRequestTraceparent(extra)).toBe(TRACEPARENT);
	});

	it("reads valid trace context from metadata before the transport header", () => {
		const extra: MaybeExtra = {
			_meta: { [TRACEPARENT_META_KEY]: TRACEPARENT },
			requestInfo: {
				headers: {
					traceparent:
						"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
				},
			},
		};
		expect(getRequestTraceparent(extra)).toBe(TRACEPARENT);
	});

	it("rejects malformed and all-zero trace identifiers", () => {
		expect(
			getRequestTraceparent({ _meta: { traceparent: "not-a-trace" } }),
		).toBeUndefined();
		expect(
			getRequestTraceparent({
				_meta: {
					traceparent:
						"00-00000000000000000000000000000000-0123456789abcdef-01",
				},
			}),
		).toBeUndefined();
	});

	it("mints a child span with the same trace id and flags", () => {
		const child = childTraceparent(TRACEPARENT)!;
		expect(child).toMatch(
			/^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/,
		);
		expect(child).not.toBe(TRACEPARENT);
	});

	it("combines chat and trace context and emits nested-call metadata", () => {
		const correlation = getRequestCorrelation({
			_meta: {
				[CHAT_SCOPE_META_KEY]: "chat-7",
				[TRACEPARENT_META_KEY]: TRACEPARENT,
			},
		});
		const meta = nestedCallMeta(correlation)!;
		expect(meta[CHAT_SCOPE_META_KEY]).toBe("chat-7");
		expect(meta[TRACEPARENT_META_KEY]).toMatch(
			/^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/,
		);
	});
});
