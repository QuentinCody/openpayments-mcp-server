/**
 * Monitoring primitive — materiality.
 *
 * Decides whether a detected change is worth surfacing. The default is
 * source-agnostic; source modules refine it (e.g. an Orange Book patent
 * delist-flip, or an expiry date crossing "now", is high-materiality).
 */

import type { Materiality, RowChange } from "./types";

/**
 * Source-agnostic default: a removed row is usually the material event (an
 * active/protected record went away), a changed row matters when any value
 * field moved, and a newly-added row is informational.
 */
export function defaultMateriality(change: RowChange): Materiality {
	if (change.kind === "removed") return "high";
	if (change.kind === "changed")
		return change.fields && change.fields.length > 0 ? "high" : "info";
	return "info";
}

/** Apply a source classifier (or the default) to every change, in place. Returns the same array. */
export function classifyChanges(
	changes: RowChange[],
	classify?: (c: RowChange) => { materiality: Materiality; label: string },
): RowChange[] {
	for (const c of changes) {
		if (classify) {
			const { materiality, label } = classify(c);
			c.materiality = materiality;
			c.label = label;
		} else {
			c.materiality = defaultMateriality(c);
		}
	}
	return changes;
}
