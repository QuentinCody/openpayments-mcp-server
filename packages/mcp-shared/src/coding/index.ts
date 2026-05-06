/**
 * `@bio-mcp/shared/coding` — controlled-vocabulary helpers for MCP servers.
 *
 * Re-exports everything in this submodule. Servers can also import individual
 * files via the `./coding/*` subpath export defined in `package.json`.
 */

export * from "./code-systems";
export * from "./coding-display";
export { LOINC_VITALS_DICT, LOINC_VITALS_REGISTRATION } from "./dicts/loinc-vitals";
