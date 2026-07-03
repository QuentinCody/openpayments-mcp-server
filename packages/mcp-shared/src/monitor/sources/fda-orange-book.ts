/**
 * Monitoring source module — FDA Orange Book exclusivity & patents.
 *
 * The flagship "exclusivity cliff" monitor: re-runs an exact-match
 * orange_book_execute query for one NDA and diffs the exclusivity + patent
 * row-sets. Field shapes were captured live (NDA 202155) — see
 * docs/design/monitoring-primitive.md §5. catalog.ts param names drift from the
 * real JSON keys, so the keys/PKs below come from the live response, not catalog.
 */

import type { RowChange, SavedQuery, SourceModule } from "../types";

/** Build the V8-isolate code for orange_book_execute. Exact-match defeats substring filtering. */
function buildCode(nda: string): string {
	const APPL = JSON.stringify(nda);
	return [
		`const APPL = ${APPL};`,
		"const exAll = (await api.get('/exclusivity', { Appl_No: APPL })).results || [];",
		"const ptAll = (await api.get('/patents', { Appl_No: APPL })).results || [];",
		"const exclusivity = exAll.filter((r) => r.Appl_No === APPL);",
		"const patents = ptAll.filter((r) => r.Appl_No === APPL);",
		"return { nda: APPL, exclusivity, patents };",
	].join("\n");
}

/** Classify one Orange Book change into the four exclusivity-cliff event types. */
function classify(change: RowChange): {
	materiality: "high" | "info";
	label: string;
} {
	const { kind, table, key } = change;
	if (kind === "removed") {
		return table === "exclusivity"
			? { materiality: "high", label: `Exclusivity lost (${key})` }
			: { materiality: "high", label: `Patent expired or delisted (${key})` };
	}
	if (kind === "added") {
		const what = table === "exclusivity" ? "exclusivity" : "patent";
		return { materiality: "info", label: `New ${what} listed (${key})` };
	}
	const fields = change.fields ?? [];
	const delist = fields.find((d) => d.field === "Delist_Flag");
	if (delist && delist.after === "Y") {
		return { materiality: "high", label: `Patent delisted (${key})` };
	}
	const dateMove = fields.find(
		(d) =>
			d.field === "Patent_Expire_Date_Text" || d.field === "Exclusivity_Date",
	);
	if (dateMove) {
		const moved = `${String(dateMove.before)} → ${String(dateMove.after)}`;
		return {
			materiality: "high",
			label: `Expiry date moved ${moved} (${key})`,
		};
	}
	return { materiality: "info", label: `Updated (${key})` };
}

/** The FDA Orange Book exclusivity + patent monitor source. */
export const fdaOrangeBook: SourceModule = {
	id: "fda-orange-book",
	label: "FDA Orange Book — exclusivity & patents",
	profile: {
		// orange_book_execute wraps the isolate return under `data`; `_meta` carries
		// volatile retrieved_at/executed_at timestamps. Strip the envelope, key on data.*.
		stripKeys: ["_meta", "success"],
		tables: [
			{
				table: "exclusivity",
				path: "data.exclusivity",
				keyFields: ["Appl_No", "Product_No", "Exclusivity_Code"],
				valueFields: ["Exclusivity_Date"],
			},
			{
				table: "patents",
				path: "data.patents",
				keyFields: ["Appl_No", "Product_No", "Patent_No", "Patent_Use_Code"],
				valueFields: [
					"Patent_Expire_Date_Text",
					"Delist_Flag",
					"Drug_Substance_Flag",
					"Drug_Product_Flag",
					"Submission_Date",
				],
			},
		],
	},
	buildQuery(input: Record<string, unknown>): SavedQuery {
		const nda = String(input.nda ?? input.appl_no ?? "").trim();
		return {
			server: "fda-orange-book",
			tool: "orange_book_execute",
			params: { code: buildCode(nda) },
		};
	},
	classify,
};
