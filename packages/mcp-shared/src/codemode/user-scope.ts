/**
 * Isolate user code from injected helpers (T4.2).
 *
 * The execute-tool isolates inject helpers (`api`, `gql`, `db`, `schema`,
 * `searchSpec`, …) as top-level `var`/`const` declarations in the SAME lexical
 * scope as the user's code. So a perfectly reasonable `const schema = …` or
 * `const api = …` in user code throws a SyntaxError ("Identifier 'schema' has
 * already been declared") before anything runs.
 *
 * Wrapping the user code in its own nested async IIFE puts it in a child scope:
 * a user `const api` now SHADOWS the injected `api` (which it can still reach via
 * closure if it doesn't redeclare it) instead of colliding with it. The user's
 * `return` propagates out through the awaited IIFE, so the result is unchanged.
 */
export function wrapInUserScope(userCode: string): string {
	return `return await (async () => {\n${userCode}\n})();`;
}
