/**
 * Authentication for the workspace-do Worker's public `/ws/*` HTTP surface (ADR-006).
 *
 * The cross-script DO-binding path (chembl/dgidb → `WORKSPACE_DO.get(id).fetch`)
 * invokes the Durable Object's own `fetch` directly and BYPASSES the Worker
 * entrypoint entirely, so it is unaffected by this guard. This protects only the
 * internet-reachable HTTP route, which would otherwise be an open relay to
 * cross-workspace staged SQL (`/ws/query`) and destructive `/ws/clear`.
 *
 * FAILS CLOSED: an unset/empty expected token denies every request. Workers have
 * no `process.env.NODE_ENV`, so the decision keys off the binding object only —
 * set `WORKSPACE_AUTH_TOKEN` as a secret (prod) or in `.dev.vars` (local).
 */

/** Length-independent constant-time string compare (no Node Buffer in Workers). */
export function timingSafeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	// Fold the length difference into the accumulator so the loop count never
	// leaks which input is longer.
	let diff = ab.length ^ bb.length;
	const len = Math.max(ab.length, bb.length);
	for (let i = 0; i < len; i++) {
		diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
	}
	return diff === 0;
}

/** Minimal header reader — satisfied by both `Request.headers` and a plain map. */
interface HeaderReader {
	get(name: string): string | null;
}

/**
 * Authorize a request against the expected bearer token. Accepts
 * `Authorization: Bearer <token>` or `x-workspace-token: <token>`. Returns
 * `false` (deny) when the expected token is unset/empty — fail closed.
 */
export function isWorkspaceRequestAuthorized(
	headers: HeaderReader,
	expectedToken: string | undefined,
): boolean {
	if (!expectedToken) return false; // fail closed: no token configured ⇒ deny
	const auth = headers.get("authorization");
	const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
	const presented = bearer ?? headers.get("x-workspace-token");
	if (!presented) return false;
	return timingSafeEqual(presented, expectedToken);
}
