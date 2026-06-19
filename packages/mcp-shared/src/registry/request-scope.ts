/**
 * Resolves the "scope" key used to bookkeep staged datasets in the
 * per-server `__registry__` DO.
 *
 * Historically this was the MCP transport session ID (`extra.sessionId`).
 * That field is removed by the MCP 2026-07-28 spec, which makes the
 * protocol stateless and moves any cross-call correlation into
 * `params._meta` or explicit tool arguments. The application-level scope
 * (a chat / conversation) is also a better fit than a transport session
 * — concurrent chats sharing a cached MCP client were silently sharing
 * the same `sessionId`, which leaked staged data between them.
 *
 * This helper centralizes the lookup so call sites don't have to know
 * which channel the scope arrived on. It tries, in order:
 *
 *   1. `extra._meta?.app?.chatId`
 *      — Spec-aligned. Set by the client when it injects per-call _meta.
 *        Not used today; will be wired up in Phase 0b.
 *
 *   2. `extra.requestInfo?.headers["mcp-chat-id"]`
 *      — HTTP header bridge. Set by the client on the transport's
 *        outbound headers. The path we'll use in Phase 0b because
 *        `@ai-sdk/mcp@1.x` has no per-call _meta hook.
 *
 *   3. `extra.sessionId`
 *      — Legacy MCP transport session. Still populated by SDKs serving
 *        the 2025-11-25 protocol; falls away naturally when both client
 *        and server move to 2026-07-28.
 *
 * Accepts either the raw `extra` object from a tool handler, a plain
 * string (for callers that have already extracted the value), or
 * `undefined`. The plain-string form exists only to keep the existing
 * ~220 call sites compiling while they get migrated to pass `extra`
 * directly; new code should pass `extra`.
 */

export interface MaybeExtra {
	/** MCP transport session ID. Deprecated by the 2026-07-28 spec. */
	sessionId?: string;
	/** Per-request metadata from JSON-RPC `params._meta`. */
	_meta?: {
		app?: { chatId?: string };
		[k: string]: unknown;
	};
	/** Underlying HTTP request info (headers etc.) surfaced by the SDK. */
	requestInfo?: {
		headers?: Record<string, string | string[] | undefined>;
	};
	[k: string]: unknown;
}

export function getRequestScope(
	source: MaybeExtra | string | undefined,
): string | undefined {
	if (source == null) return undefined;
	if (typeof source === "string") return source.length > 0 ? source : undefined;

	const fromMeta = source._meta?.app?.chatId;
	if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;

	const headers = source.requestInfo?.headers;
	if (headers) {
		const raw = headers["mcp-chat-id"] ?? headers["Mcp-Chat-Id"];
		const value = Array.isArray(raw) ? raw[0] : raw;
		if (typeof value === "string" && value.length > 0) return value;
	}

	const fromSession = source.sessionId;
	if (typeof fromSession === "string" && fromSession.length > 0) return fromSession;

	return undefined;
}
