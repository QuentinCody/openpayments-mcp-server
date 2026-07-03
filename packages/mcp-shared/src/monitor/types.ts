// interlinked-tdd: exempt -- type-only declarations, no runtime surface
/**
 * Monitoring primitive — core types.
 *
 * A monitor = saved query + schedule + diff + materiality + delivery. These
 * types are deliberately serializable: a subscription is persisted in SQLite,
 * so the per-source LOGIC (how to build the query, how to classify a change)
 * lives in a {@link SourceModule} keyed by id — never in the stored row.
 *
 * Row identity is a per-table BUSINESS KEY chosen here, NEVER the staging
 * engine's synthetic auto-increment PK (which is insertion-order and not stable
 * across re-fetches). See docs/design/monitoring-primitive.md §2.2.
 */

/** A re-runnable query against a fleet server: {server, tool, params}. */
export interface SavedQuery {
	/** Target server alias, e.g. "fda-orange-book". */
	server: string;
	/** Tool name, e.g. "orange_book_execute". */
	tool: string;
	/** Tool arguments. */
	params: Record<string, unknown>;
}

/** Locates and keys one logical table of rows inside a tool result. */
export interface TableSpec {
	/** Logical table name, e.g. "exclusivity". */
	table: string;
	/** Dot-path to the row array inside the cleaned result, e.g. "exclusivity" or "data.rows". */
	path: string;
	/** Composite business-key fields. Row identity = these values, joined. */
	keyFields: string[];
	/** Fields compared to decide "changed". Defaults to all non-key, non-ignored fields. */
	valueFields?: string[];
	/** Volatile fields dropped before hashing / comparison. */
	ignoreFields?: string[];
}

/** Canonicalization + keying profile for a subscription's results. */
export interface MonitorProfile {
	/** Top-level envelope keys removed before extraction (pagination / meta). */
	stripKeys?: string[];
	/** One entry per diffable table. */
	tables: TableSpec[];
}

export type ChangeKind = "added" | "removed" | "changed";
export type Materiality = "high" | "info";

/** One field that differs within a changed row. */
export interface FieldDelta {
	field: string;
	before: unknown;
	after: unknown;
}

/** A single detected change to one keyed row. */
export interface RowChange {
	table: string;
	kind: ChangeKind;
	/** Display key: keyFields joined by "|". */
	key: string;
	/** keyField → value, for structured consumers. */
	keyValues: Record<string, unknown>;
	/** Present for added / changed. */
	after?: Record<string, unknown>;
	/** Present for removed / changed. */
	before?: Record<string, unknown>;
	/** Present for changed. */
	fields?: FieldDelta[];
	/** Set by a {@link SourceModule.classify} (or defaultMateriality). */
	materiality?: Materiality;
	/** Human-readable one-liner, set by classify. */
	label?: string;
}

/** Per-table tallies for one diff. */
export interface TableSummary {
	table: string;
	added: number;
	removed: number;
	changed: number;
	unchanged: number;
}

/** Result of diffing two snapshots. */
export interface SnapshotDiff {
	changes: RowChange[];
	summary: TableSummary[];
}

/**
 * Binds a server's tool to a monitor: how to build the query from user input,
 * how to canonicalize/key its result, and how to classify a change's
 * materiality. Lives in code (functions are not serializable); a subscription
 * references it by {@link SourceModule.id} and stores only its `input`.
 */
export interface SourceModule {
	/** Stable id, e.g. "fda-orange-book". */
	id: string;
	/** Human label, e.g. "FDA Orange Book — exclusivity & patents". */
	label: string;
	/** Canonicalization + keying profile for results of this source. */
	profile: MonitorProfile;
	/** Build the re-runnable {server, tool, params} from user input (e.g. an NDA number). */
	buildQuery(input: Record<string, unknown>): SavedQuery;
	/** Classify + label one change. Falls back to {@link defaultMateriality} when omitted. */
	classify?(change: RowChange): { materiality: Materiality; label: string };
}
