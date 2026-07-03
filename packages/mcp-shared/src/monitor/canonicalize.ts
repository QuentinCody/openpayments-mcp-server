/**
 * Monitoring primitive — canonicalization + row extraction.
 *
 * Turns a raw MCP tool result into stable, keyed row-sets a diff can compare.
 * The hard requirements (see docs/design/monitoring-primitive.md §2.2):
 *   - strip volatile envelope/meta keys so they never look like a change;
 *   - re-parse stringified-JSON and pipe-delimited columns so upstream key
 *     order / array serialization does not churn the hash;
 *   - hash a key→value-projection MAP (order-independent), not the row array,
 *     so a pure upstream reorder is correctly seen as "no change".
 */

import { canonicalJson, sha256Hex } from "../provenance/provenance";
import type { MonitorProfile, TableSpec } from "./types";

/** A logical table of rows extracted from a tool result. */
export interface RowSet {
	table: string;
	rows: Array<Record<string, unknown>>;
}

/** Resolve a dot-path (e.g. "a.b.c") within a value; returns undefined if absent. */
export function resolvePath(value: unknown, path: string): unknown {
	if (!path) return value;
	let cur: unknown = value;
	for (const seg of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/** Remove top-level envelope / meta keys that change without semantic meaning. */
export function cleanResult(result: unknown, profile: MonitorProfile): unknown {
	if (result === null || typeof result !== "object" || Array.isArray(result))
		return result;
	const strip = new Set(profile.stripKeys ?? []);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
		if (!strip.has(k)) out[k] = v;
	}
	return out;
}

/** Extract each declared table's rows from a cleaned result. */
export function extractRowSets(
	result: unknown,
	profile: MonitorProfile,
): RowSet[] {
	const cleaned = cleanResult(result, profile);
	return profile.tables.map((spec) => {
		const located = resolvePath(cleaned, spec.path);
		const rows = Array.isArray(located)
			? located.filter(
					(r): r is Record<string, unknown> =>
						r !== null && typeof r === "object" && !Array.isArray(r),
				)
			: [];
		return { table: spec.table, rows };
	});
}

/** Separator joining composite-key parts. Business-key fields are identifiers, never pipe-bearing. */
export const KEY_SEP = "|";

/** Composite business key for one row, per the table spec. */
export function rowKey(row: Record<string, unknown>, spec: TableSpec): string {
	return spec.keyFields.map((f) => stringifyKeyPart(row[f])).join(KEY_SEP);
}

function stringifyKeyPart(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "object") return canonicalJson(v);
	return String(v);
}

/** The subset of fields used to decide whether a row "changed". */
export function selectValueFields(
	row: Record<string, unknown>,
	spec: TableSpec,
): string[] {
	if (spec.valueFields && spec.valueFields.length > 0) return spec.valueFields;
	const ignore = new Set([...(spec.ignoreFields ?? []), ...spec.keyFields]);
	return Object.keys(row).filter((k) => !ignore.has(k));
}

/** Parse a string as JSON, returning undefined (rather than throwing) when it is not JSON. */
function tryJsonParse(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

/**
 * Re-parse stringified JSON / pipe-delimited columns so the canonical form is
 * stable regardless of upstream key order or array serialization. Staging
 * stores JSON columns as `JSON.stringify` output and scalar arrays as
 * "A | B | C"; hashing the raw TEXT would be order-sensitive.
 */
export function reparse(v: unknown): unknown {
	if (typeof v !== "string") return v;
	const s = v.trim();
	if (
		(s.startsWith("{") && s.endsWith("}")) ||
		(s.startsWith("[") && s.endsWith("]"))
	) {
		const parsed = tryJsonParse(s);
		if (parsed !== undefined) return parsed;
	}
	if (s.includes(" | ")) {
		return s
			.split(" | ")
			.map((p) => p.trim())
			.sort();
	}
	return v;
}

/** Canonical string of a row's value-projection (order-independent, re-parsed). */
export function canonicalValue(
	row: Record<string, unknown>,
	spec: TableSpec,
): string {
	const proj: Record<string, unknown> = {};
	for (const f of selectValueFields(row, spec)) proj[f] = reparse(row[f]);
	return canonicalJson(proj);
}

/** A keyed value-projection map for one table: businessKey → canonical value string. */
export function keyedValueMap(
	rs: RowSet,
	spec: TableSpec,
): Record<string, string> {
	const keyed: Record<string, string> = {};
	for (const row of rs.rows)
		keyed[rowKey(row, spec)] = canonicalValue(row, spec);
	return keyed;
}

/**
 * Content hash of a full snapshot: a key→value-projection map per table, hashed
 * order-independently. Identical data in any row order yields the same hash, so
 * it is a reliable "nothing changed" gate (unlike the staging synthetic PK).
 */
export async function snapshotHash(
	rowSets: RowSet[],
	profile: MonitorProfile,
): Promise<string> {
	const specByTable = new Map(profile.tables.map((t) => [t.table, t]));
	const byTable: Record<string, Record<string, string>> = {};
	for (const rs of rowSets) {
		const spec = specByTable.get(rs.table);
		if (!spec) continue;
		byTable[rs.table] = keyedValueMap(rs, spec);
	}
	return sha256Hex(canonicalJson(byTable));
}
