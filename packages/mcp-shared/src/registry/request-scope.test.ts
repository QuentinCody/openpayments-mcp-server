import { describe, it, expect } from "vitest";
import { getRequestScope, type MaybeExtra } from "./request-scope";

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

	it("reads _meta.app.chatId when present", () => {
		const extra: MaybeExtra = {
			_meta: { app: { chatId: "chat-1" } },
		};
		expect(getRequestScope(extra)).toBe("chat-1");
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
			requestInfo: { headers: { "mcp-chat-id": ["chat-first", "chat-second"] } },
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
			_meta: { app: { chatId: "meta-high" } },
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

	it("skips empty _meta.app.chatId and falls through to header", () => {
		const extra: MaybeExtra = {
			_meta: { app: { chatId: "" } },
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
			_meta: { app: { chatId: "" } },
			requestInfo: { headers: { "mcp-chat-id": "" } },
			sessionId: "",
		};
		expect(getRequestScope(extra)).toBeUndefined();
	});

	it("returns undefined when extra is an empty object", () => {
		expect(getRequestScope({})).toBeUndefined();
	});

	it("ignores non-string _meta.app.chatId values", () => {
		const extra = {
			_meta: { app: { chatId: 123 as unknown as string } },
			sessionId: "session-fallback",
		} as MaybeExtra;
		expect(getRequestScope(extra)).toBe("session-fallback");
	});

	it("ignores _meta with no app block", () => {
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
