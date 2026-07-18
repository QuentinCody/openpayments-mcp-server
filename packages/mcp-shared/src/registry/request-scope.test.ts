import { describe, expect, it } from "vitest";
import { CHAT_SCOPE_META_KEY, getRequestScope, type MaybeExtra } from "./request-scope";

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
