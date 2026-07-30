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
 *   1. `context.mcpReq._meta?.[CHAT_SCOPE_META_KEY]`, then the v1-compatible
 *      `extra._meta` shape — Spec-aligned. Set by clients that inject per-call
 *      `_meta`, including the orchestrator's nested tool calls.
 *
 *   2. `context.http.req.headers`, then v1's `extra.requestInfo.headers`
 *      — HTTP header bridge for clients without a per-call `_meta` hook.
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

/**
 * `_meta` key carrying the application-level chat scope.
 *
 * The MCP `_meta` key format is an optional reverse-DNS prefix plus a name,
 * and the spec reserves any prefix whose *second* label is `mcp` or
 * `modelcontextprotocol`. A bare name like `app` is legal but squats on a
 * generic identifier that another server or extension could also claim, so we
 * namespace under a domain we control (`bio.quentincody.dev` reversed).
 *
 * Exported as a constant so client-side injectors and server-side readers
 * cannot drift apart on a typo.
 */
export const CHAT_SCOPE_META_KEY = "dev.quentincody.bio/chatId";
export const TRACEPARENT_META_KEY = "traceparent";
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface MaybeExtra {
	/** MCP transport session ID. Deprecated by the 2026-07-28 spec. */
	sessionId?: string;
	/** Per-request metadata from JSON-RPC `params._meta`. */
	_meta?: {
		[CHAT_SCOPE_META_KEY]?: string;
		[k: string]: unknown;
	};
	/** MCP SDK v2 request context. */
	mcpReq?: {
		_meta?: {
			[CHAT_SCOPE_META_KEY]?: string;
			[k: string]: unknown;
		};
	};
	/** MCP SDK v2 HTTP request context. */
	http?: {
		req?: Request;
	};
	/** Underlying HTTP request info (headers etc.) surfaced by the SDK. */
	requestInfo?: {
		headers?: Record<string, string | string[] | undefined>;
	};
	[k: string]: unknown;
}

export interface RequestCorrelation {
	chatId?: string;
	traceparent?: string;
}

function headerValue(
	headers: Record<string, string | string[] | undefined> | undefined,
	lowercase: string,
	canonical: string,
): string | undefined {
	const raw = headers?.[lowercase] ?? headers?.[canonical];
	const value = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function v2HeaderValue(
	source: MaybeExtra | undefined,
	name: string,
): string | undefined {
	return source?.http?.req?.headers.get(name) ?? undefined;
}

export function validTraceparent(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = TRACEPARENT_PATTERN.exec(value);
	if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2]))
		return undefined;
	return value.toLowerCase();
}

export function getRequestTraceparent(
	source: MaybeExtra | undefined,
): string | undefined {
	return (
		validTraceparent(source?.mcpReq?._meta?.[TRACEPARENT_META_KEY]) ??
		validTraceparent(source?._meta?.[TRACEPARENT_META_KEY]) ??
		validTraceparent(v2HeaderValue(source, "traceparent")) ??
		validTraceparent(
			headerValue(source?.requestInfo?.headers, "traceparent", "Traceparent"),
		)
	);
}

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

/** Create a W3C child span while preserving the parent trace and flags. */
export function childTraceparent(
	parent: string | undefined,
): string | undefined {
	const valid = validTraceparent(parent);
	if (!valid) return undefined;
	const [, traceId, , flags] = TRACEPARENT_PATTERN.exec(valid)!;
	return `00-${traceId}-${randomHex(8)}-${flags}`;
}

export function getRequestCorrelation(
	source: MaybeExtra | undefined,
): RequestCorrelation | undefined {
	const chatId = getRequestScope(source);
	const traceparent = getRequestTraceparent(source);
	return chatId || traceparent ? { chatId, traceparent } : undefined;
}

/** Build fresh per-call metadata for one nested tools/call request. */
export function nestedCallMeta(
	correlation: RequestCorrelation | undefined,
): Record<string, unknown> | undefined {
	if (!correlation) return undefined;
	const meta: Record<string, unknown> = {};
	if (correlation.chatId) meta[CHAT_SCOPE_META_KEY] = correlation.chatId;
	const traceparent = childTraceparent(correlation.traceparent);
	if (traceparent) meta[TRACEPARENT_META_KEY] = traceparent;
	return Object.keys(meta).length > 0 ? meta : undefined;
}

export function getRequestScope(
	source: MaybeExtra | string | undefined,
): string | undefined {
	if (source == null) return undefined;
	if (typeof source === "string") return source.length > 0 ? source : undefined;

	const fromMeta =
		source.mcpReq?._meta?.[CHAT_SCOPE_META_KEY] ??
		source._meta?.[CHAT_SCOPE_META_KEY];
	if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;

	const fromV2Header = v2HeaderValue(source, "mcp-chat-id");
	if (fromV2Header) return fromV2Header;

	const fromHeader = headerValue(
		source.requestInfo?.headers,
		"mcp-chat-id",
		"Mcp-Chat-Id",
	);
	if (fromHeader) return fromHeader;

	const fromSession = source.sessionId;
	if (typeof fromSession === "string" && fromSession.length > 0)
		return fromSession;

	return undefined;
}
