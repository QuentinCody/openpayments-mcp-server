/**
 * Monitoring primitive — one monitor tick.
 *
 * Glues the engine into the loop the MonitorDO alarm runs each cadence:
 * build query → re-run in-fabric → canonicalize → content-hash → diff vs prior
 * → classify materiality. The query runner is injected, so this is pure and
 * unit-testable with a fake (the DO supplies the real in-fabric caller).
 */

import {
	cleanResult,
	extractRowSets,
	type RowSet,
	snapshotHash,
} from "./canonicalize";
import { diffSnapshots } from "./diff";
import { classifyChanges } from "./materiality";
import type {
	RowChange,
	SavedQuery,
	SnapshotDiff,
	SourceModule,
} from "./types";

/** Re-run {server,tool,params} in-fabric and return the parsed tool result. */
export type QueryRunner = (query: SavedQuery) => Promise<unknown>;

export interface RunOnceInput {
	source: SourceModule;
	input: Record<string, unknown>;
	run: QueryRunner;
	/** Prior snapshot's row-sets (null/omitted on the first run). */
	priorRowSets?: RowSet[] | null;
	/** Prior snapshot's content hash, to short-circuit the no-change case. */
	priorContentHash?: string | null;
}

export interface RunOnceResult {
	/** The {server,tool,params} that was run. */
	query: SavedQuery;
	/** Order-independent semantic hash of the new result (the no-change gate). */
	contentHash: string;
	/** The cleaned result (envelope stripped) — the snapshot-bytes source. */
	cleaned: unknown;
	/** Extracted row-sets for the new result. */
	rowSets: RowSet[];
	/** Diff vs the prior row-sets (empty when prior is null = baseline). */
	diff: SnapshotDiff;
	/** Material + labeled changes (classified by the source module). */
	changes: RowChange[];
	/** True when contentHash equals priorContentHash (nothing changed upstream). */
	unchanged: boolean;
}

/** Run one monitor tick against the live source and diff it against the prior snapshot. */
export async function runOnce(args: RunOnceInput): Promise<RunOnceResult> {
	const query = args.source.buildQuery(args.input);
	const raw = await args.run(query);
	const cleaned = cleanResult(raw, args.source.profile);
	const rowSets = extractRowSets(raw, args.source.profile);
	const contentHash = await snapshotHash(rowSets, args.source.profile);
	const unchanged =
		args.priorContentHash != null && contentHash === args.priorContentHash;
	const diff: SnapshotDiff = args.priorRowSets
		? diffSnapshots(args.priorRowSets, rowSets, args.source.profile)
		: { changes: [], summary: [] };
	const changes = classifyChanges(diff.changes, args.source.classify);
	return { query, contentHash, cleaned, rowSets, diff, changes, unchanged };
}
