/**
 * Monitoring primitive — snapshot hash-chain (provenance ledger).
 *
 * Generalizes the clinical-orchestrator tamper-evident audit chain (Tier A)
 * onto the shared provenance primitives. Each snapshot row commits to:
 *   (a) `payload_hash` = sha256 of the stored snapshot bytes, and
 *   (b) `prev_hash`    = the previous row's entry hash (a classic hash chain),
 * with `content_hash` (the order-independent semantic hash) also covered by the
 * entry hash. Any post-hoc edit, deletion, or reorder breaks the chain and is
 * pinpointed by {@link verifyChainRows}.
 *
 * Scope (Tier A) — tamper-EVIDENCE, not tamper-PROOFING: no signing, no external
 * anchoring (an actor who can rewrite the whole table can recompute a consistent
 * chain). Signing + anchoring are deliberate Tier B/C follow-ups.
 *
 * The chain is single-homed in one MonitorDO, so the module-level append lock +
 * the (subscription_id, seq) PK give fork-free appends. Reuses canonicalJson /
 * sha256Hex from @bio-mcp/shared/provenance — do NOT make a third copy.
 */

import { canonicalJson, sha256Hex } from "../provenance/provenance";

/** Genesis link for the first row in a chain (no predecessor). */
export const GENESIS_HASH = "0".repeat(64);

/** A `ctx.storage.sql` tagged-template runner (rows returned as objects). */
export type SqlRunner = <T = Record<string, unknown>>(
	strings: TemplateStringsArray,
	...values: unknown[]
) => T[];

export interface SnapshotInput {
	subscriptionId: string;
	/** sha256(canonicalJson({server,tool,params})) — attests WHAT was monitored. */
	queryDescriptorHash: string;
	/** Order-independent semantic hash of the keyed result (the no-change gate). */
	contentHash: string;
	/** canonicalJson(cleaned result) — the snapshot bytes. */
	payloadJson: string;
	/** The diff vs the prior snapshot, serialized (null for the baseline snapshot). */
	diffJson?: string | null;
}

export interface SnapshotRow {
	seq: number;
	subscription_id: string;
	query_descriptor_hash: string;
	content_hash: string;
	payload_json: string;
	payload_hash: string;
	diff_json: string | null;
	prev_hash: string;
	entry_hash: string;
	created_at: string;
}

/**
 * The exact, stably-ordered fields that entry_hash commits to. Keeping this in
 * one place guarantees the writer ({@link buildSnapshotRow}) and the verifier
 * ({@link verifyChainRows}) hash byte-identical input. `payload_json` and
 * `diff_json` are committed only indirectly (via payload_hash) to keep the
 * hashed core small.
 */
function entryCore(r: SnapshotRow): Record<string, unknown> {
	return {
		seq: Number(r.seq),
		subscription_id: r.subscription_id,
		query_descriptor_hash: r.query_descriptor_hash,
		content_hash: r.content_hash,
		payload_hash: r.payload_hash,
		prev_hash: r.prev_hash,
		created_at: r.created_at,
	};
}

/** Compute the chained entry hash for a fully-populated row. */
export async function computeEntryHash(row: SnapshotRow): Promise<string> {
	return sha256Hex(canonicalJson(entryCore(row)));
}

/**
 * Build (but do not persist) the next chain row given the current tail. Pure
 * and deterministic except for created_at, which can be pinned via `opts` for
 * testing. Exposed so tests exercise the real hashing path without a SQL layer.
 */
export async function buildSnapshotRow(
	prevSeq: number,
	prevHash: string,
	input: SnapshotInput,
	opts?: { createdAt?: string },
): Promise<SnapshotRow> {
	const created_at = opts?.createdAt ?? new Date().toISOString();
	const payload_hash = await sha256Hex(input.payloadJson);
	const row: SnapshotRow = {
		seq: prevSeq + 1,
		subscription_id: input.subscriptionId,
		query_descriptor_hash: input.queryDescriptorHash,
		content_hash: input.contentHash,
		payload_json: input.payloadJson,
		payload_hash,
		diff_json: input.diffJson ?? null,
		prev_hash: prevHash,
		entry_hash: "",
		created_at,
	};
	row.entry_hash = await computeEntryHash(row);
	return row;
}

export interface ChainVerifyResult {
	valid: boolean;
	count: number;
	/** entry_hash of the last verified row (or GENESIS_HASH for an empty chain). */
	head: string;
	/** seq of the first row that failed verification, if any. */
	brokenSeq?: number;
	reason?: string;
}

/**
 * Verify a chain given its rows in seq-ascending order. Recomputes every
 * payload + entry hash, asserts gapless monotonic seq, and asserts each row
 * links to its predecessor. Returns the first failure with its seq.
 */
export async function verifyChainRows(
	rows: SnapshotRow[],
): Promise<ChainVerifyResult> {
	let prev = GENESIS_HASH;
	let expectedSeq = 1;
	for (const row of rows) {
		const seq = Number(row.seq);
		if (seq !== expectedSeq) {
			return {
				valid: false,
				count: rows.length,
				head: prev,
				brokenSeq: seq,
				reason: `sequence break: expected seq ${expectedSeq}, found ${seq} (a row was deleted, inserted, or reordered)`,
			};
		}
		if (row.prev_hash !== prev) {
			return {
				valid: false,
				count: rows.length,
				head: prev,
				brokenSeq: seq,
				reason: `prev_hash mismatch at seq ${seq} (a prior row was altered or removed)`,
			};
		}
		const payloadHash = await sha256Hex(row.payload_json);
		if (payloadHash !== row.payload_hash) {
			return {
				valid: false,
				count: rows.length,
				head: prev,
				brokenSeq: seq,
				reason: `payload tampered at seq ${seq} (payload_json no longer matches payload_hash)`,
			};
		}
		const entryHash = await computeEntryHash(row);
		if (entryHash !== row.entry_hash) {
			return {
				valid: false,
				count: rows.length,
				head: prev,
				brokenSeq: seq,
				reason: `entry_hash mismatch at seq ${seq} (row metadata was altered)`,
			};
		}
		prev = row.entry_hash;
		expectedSeq++;
	}
	return { valid: true, count: rows.length, head: prev };
}

/**
 * Serialize appends within the isolate. A Durable Object is single-homed, so
 * chaining this promise closes the read-tail → await sha256 → insert interleave
 * window that would otherwise fork two appends off the same prev_hash. The
 * (subscription_id, seq) PK is a second-line guard: a forked append collides on
 * seq and throws rather than silently corrupting the chain.
 */
let appendLock: Promise<unknown> = Promise.resolve();

/**
 * Append one snapshot to `monitor_snapshot` and return its seq + head hash.
 * Caller must `await` (the hashing is async). Safe under concurrency.
 */
export async function appendSnapshot(
	sql: SqlRunner,
	input: SnapshotInput,
): Promise<{ seq: number; entry_hash: string; content_hash: string }> {
	const run = appendLock.then(() => doAppend(sql, input));
	appendLock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function doAppend(
	sql: SqlRunner,
	input: SnapshotInput,
): Promise<{ seq: number; entry_hash: string; content_hash: string }> {
	const tail = sql<{ seq: number; entry_hash: string }>`
		SELECT seq, entry_hash FROM monitor_snapshot
		WHERE subscription_id = ${input.subscriptionId}
		ORDER BY seq DESC LIMIT 1
	`;
	const prevSeq = tail.length > 0 ? Number(tail[0].seq) : 0;
	const prevHash = tail.length > 0 ? tail[0].entry_hash : GENESIS_HASH;

	const row = await buildSnapshotRow(prevSeq, prevHash, input);

	sql`
		INSERT INTO monitor_snapshot (
			seq, subscription_id, query_descriptor_hash, content_hash,
			payload_json, payload_hash, diff_json, prev_hash, entry_hash, created_at
		) VALUES (
			${row.seq}, ${row.subscription_id}, ${row.query_descriptor_hash}, ${row.content_hash},
			${row.payload_json}, ${row.payload_hash}, ${row.diff_json}, ${row.prev_hash}, ${row.entry_hash}, ${row.created_at}
		)
	`;

	return {
		seq: row.seq,
		entry_hash: row.entry_hash,
		content_hash: row.content_hash,
	};
}

/** Read a subscription's full chain from SQLite and verify it end to end. */
export async function verifySnapshotChain(
	sql: SqlRunner,
	subscriptionId: string,
): Promise<ChainVerifyResult> {
	const rows = sql<SnapshotRow>`
		SELECT * FROM monitor_snapshot WHERE subscription_id = ${subscriptionId} ORDER BY seq ASC
	`;
	return verifyChainRows(rows);
}
