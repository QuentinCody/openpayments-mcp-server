// Self-describing staged-query errors (the fleet-wide twin of cf's
// workspace-tools.enrichQueryError).
//
// When a model's SQL hits "no such column/table" against a staged dataset, we
// append the REAL table + column names so it self-corrects in ONE step instead
// of guessing again or reaching for PRAGMA/sqlite_master. The error teaches the
// fix. Applied in query-handlers.ts so every staging server (~110) inherits it
// on its `*_query_data` tool. Also reframes Cloudflare DO SQLite's compound-
// SELECT cap (~10 UNION/INTERSECT/EXCEPT terms, far below standard SQLite's
// ~500), which a model-authored mega-UNION across staged tables can hit.

type ColumnLike = { name?: unknown } | string;
type TableLike = { name?: unknown; columns?: unknown };

/** Normalize a `tables` value — which may be an object keyed by table name
 *  (per-server get_schema: `{tables:{name:{columns:[…]}}}`) or an array of
 *  `{name, columns}` (workspace datasets) — into `[name, columns]` pairs. */
function tableEntries(tables: unknown): Array<[string, ColumnLike[]]> {
	const out: Array<[string, ColumnLike[]]> = [];
	if (Array.isArray(tables)) {
		for (const t of tables) {
			if (typeof t === "string") {
				out.push([t, []]); // registry-list shape: bare table names
			} else if (t && typeof t === "object" && typeof (t as TableLike).name === "string") {
				const cols = (t as TableLike).columns;
				out.push([(t as TableLike).name as string, Array.isArray(cols) ? cols : []]);
			}
		}
	} else if (tables && typeof tables === "object") {
		for (const [name, v] of Object.entries(tables as Record<string, unknown>)) {
			const cols = (v as TableLike)?.columns;
			out.push([name, Array.isArray(cols) ? cols : []]);
		}
	}
	return out;
}

function colName(c: ColumnLike): string | undefined {
	if (typeof c === "string") return c;
	if (c && typeof c === "object" && typeof c.name === "string") return c.name;
	return undefined;
}

/** Render staged tables + columns compactly so a "no such column/table" error
 *  can hand the model the exact names to fix its SQL in one step. Handles the
 *  per-server get_schema shape (`{schema:{tables:{name:{columns:[…]}}}}`), the
 *  workspace shape (`{schema:{datasets:[{tables:[…]}]}}`), and the bare forms. */
export function renderStagedSchemaHint(raw: unknown): string {
	const root = (
		raw && typeof raw === "object" && "schema" in (raw as object)
			? (raw as { schema: unknown }).schema
			: raw
	) as { tables?: unknown; datasets?: unknown } | null;
	if (!root || typeof root !== "object") return "";
	const pairs: Array<[string, ColumnLike[]]> = [];
	if (Array.isArray(root.datasets)) {
		for (const ds of root.datasets) {
			pairs.push(...tableEntries((ds as { tables?: unknown })?.tables));
		}
	}
	pairs.push(...tableEntries(root.tables));
	const lines: string[] = [];
	for (const [name, cols] of pairs) {
		const names = cols
			.map(colName)
			.filter((n): n is string => typeof n === "string");
		lines.push(`${name}(${names.join(", ")})`);
	}
	if (lines.length === 0) return "";
	return (
		"\n\nAvailable staged tables & columns — use these EXACT names:\n" +
		lines.join("\n")
	);
}

/** Cloudflare DO SQLite caps a compound SELECT at ~10 UNION/INTERSECT/EXCEPT
 *  terms (not standard SQLite's ~500). Reframe that engine error into a remedy. */
export function reframeCompoundSelect(msg: string): string {
	if (/too many terms in compound SELECT/i.test(msg)) {
		return (
			"This dataset runs on Cloudflare DO SQLite, which caps a compound SELECT at ~10 " +
			"UNION/INTERSECT/EXCEPT terms. Split the UNION ALL into batches of at most 8 and combine " +
			"across several query calls, or query the tables individually."
		);
	}
	return msg;
}

/** Turn a raw staged-query SQL error into an actionable one: append the real
 *  schema for "no such column/table" (fetched via `fetchSchema`); otherwise
 *  reframe the compound-SELECT cap. Best-effort — a failed schema fetch falls
 *  back to the plain (still useful) error, never throws. */
export async function enrichStagedQueryError(
	msg: string,
	fetchSchema: () => Promise<unknown>,
): Promise<string> {
	if (/no such (column|table)/i.test(msg)) {
		try {
			const hint = renderStagedSchemaHint(await fetchSchema());
			if (hint) return msg + hint;
		} catch (e) {
			console.warn(
				"staged schema-hint fetch failed:",
				e instanceof Error ? e.message : String(e),
			);
		}
	}
	return reframeCompoundSelect(msg);
}
