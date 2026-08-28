/**
 * Data Use Ontology (DUO) codes for citations.
 *
 * A citation already carries a free-text `license`, which a human can read and
 * a program cannot act on. DUO codes make the same terms machine-checkable:
 * "may this result be redistributed, and under what conditions" becomes a
 * lookup rather than a string match against licence prose.
 *
 * The term table below is transcribed from the ontology's own release file
 * (EBISPOT/DUO `duo.csv`), including the permission/modifier split, which is
 * taken from each term's definition text rather than assumed. Codes and
 * shorthands are easy to misremember — `DUO:0000018` is NPUNCU (not for
 * profit, non commercial use only), while NPU (not for profit organisation use
 * only) is `DUO:0000045`.
 */

export type DuoKind = "permission" | "modifier" | "root";

export interface DuoTerm {
	/** Ontology shorthand, e.g. "GRU". Absent for the two root classes. */
	shorthand?: string;
	label: string;
	kind: DuoKind;
}

/** Every term in the DUO release, keyed by CURIE. */
export const DUO_TERMS: Readonly<Record<string, DuoTerm>> = {
	"DUO:0000001": { label: "data use permission", kind: "root" },
	"DUO:0000004": { shorthand: "NRES", label: "no restriction", kind: "permission" },
	"DUO:0000006": {
		shorthand: "HMB",
		label: "health or medical or biomedical research",
		kind: "permission",
	},
	"DUO:0000007": {
		shorthand: "DS",
		label: "disease specific research",
		kind: "permission",
	},
	"DUO:0000011": {
		shorthand: "POA",
		label: "population origins or ancestry research only",
		kind: "permission",
	},
	"DUO:0000012": {
		shorthand: "RS",
		label: "research specific restrictions",
		kind: "modifier",
	},
	"DUO:0000015": {
		shorthand: "NMDS",
		label: "no general methods research",
		kind: "modifier",
	},
	"DUO:0000016": {
		shorthand: "GSO",
		label: "genetic studies only",
		kind: "modifier",
	},
	"DUO:0000017": { label: "data use modifier", kind: "root" },
	"DUO:0000018": {
		shorthand: "NPUNCU",
		label: "not for profit, non commercial use only",
		kind: "modifier",
	},
	"DUO:0000019": {
		shorthand: "PUB",
		label: "publication required",
		kind: "modifier",
	},
	"DUO:0000020": {
		shorthand: "COL",
		label: "collaboration required",
		kind: "modifier",
	},
	"DUO:0000021": {
		shorthand: "IRB",
		label: "ethics approval required",
		kind: "modifier",
	},
	"DUO:0000022": {
		shorthand: "GS",
		label: "geographical restriction",
		kind: "modifier",
	},
	"DUO:0000024": {
		shorthand: "MOR",
		label: "publication moratorium",
		kind: "modifier",
	},
	"DUO:0000025": { shorthand: "TS", label: "time limit on use", kind: "modifier" },
	"DUO:0000026": {
		shorthand: "US",
		label: "user specific restriction",
		kind: "modifier",
	},
	"DUO:0000027": {
		shorthand: "PS",
		label: "project specific restriction",
		kind: "modifier",
	},
	"DUO:0000028": {
		shorthand: "IS",
		label: "institution specific restriction",
		kind: "modifier",
	},
	"DUO:0000029": {
		shorthand: "RTN",
		label: "return to database or resource",
		kind: "modifier",
	},
	"DUO:0000042": {
		shorthand: "GRU",
		label: "general research use",
		kind: "permission",
	},
	"DUO:0000043": { shorthand: "CC", label: "clinical care use", kind: "modifier" },
	"DUO:0000044": {
		shorthand: "NPOA",
		label: "population origins or ancestry research prohibited",
		kind: "modifier",
	},
	"DUO:0000045": {
		shorthand: "NPU",
		label: "not for profit organisation use only",
		kind: "modifier",
	},
	"DUO:0000046": {
		shorthand: "NCU",
		label: "non-commercial use only",
		kind: "modifier",
	},
};

const DUO_CURIE_RE = /^DUO:\d{7}$/;

/** True for a syntactically well-formed DUO CURIE. */
export function isDuoCurie(value: unknown): value is string {
	return typeof value === "string" && DUO_CURIE_RE.test(value);
}

/**
 * True for a code a dataset can actually be annotated with. The two root
 * classes are the parents of the vocabulary, not usable annotations.
 */
export function isUsableDuoCode(value: unknown): value is string {
	if (!isDuoCurie(value)) return false;
	const term = DUO_TERMS[value];
	return term !== undefined && term.kind !== "root";
}

export function describeDuoCode(code: string): DuoTerm | undefined {
	return DUO_TERMS[code];
}

/** Resolve a shorthand such as "GRU" to its CURIE. Case-insensitive. */
export function duoCodeForShorthand(shorthand: string): string | undefined {
	const wanted = shorthand.trim().toUpperCase();
	for (const [code, term] of Object.entries(DUO_TERMS)) {
		if (term.shorthand === wanted) return code;
	}
	return undefined;
}

/**
 * Keep only usable codes, de-duplicated and ordered, so two servers annotating
 * the same dataset produce byte-identical citations.
 */
export function normalizeDuoCodes(codes: readonly unknown[]): string[] {
	return [...new Set(codes.filter(isUsableDuoCode))].sort();
}

/** The conditions a set of DUO codes places on reusing a result. */
export interface DuoObligations {
	nonCommercialOnly: boolean;
	notForProfitOnly: boolean;
	publicationRequired: boolean;
	publicationMoratorium: boolean;
	ethicsApprovalRequired: boolean;
	collaborationRequired: boolean;
	geographicRestriction: boolean;
	returnToResource: boolean;
	/** Any modifier at all, including ones with no dedicated flag above. */
	hasRestrictions: boolean;
}

const NON_COMMERCIAL_CODES = ["DUO:0000046", "DUO:0000018"];
const NOT_FOR_PROFIT_CODES = ["DUO:0000045", "DUO:0000018"];

/**
 * Reduce DUO codes to actionable obligations. Unknown or root codes are
 * ignored, so an unrecognised annotation can never silently grant permission.
 */
export function duoObligations(codes: readonly string[]): DuoObligations {
	const present = new Set(normalizeDuoCodes(codes));
	const has = (code: string) => present.has(code);
	return {
		nonCommercialOnly: NON_COMMERCIAL_CODES.some(has),
		notForProfitOnly: NOT_FOR_PROFIT_CODES.some(has),
		publicationRequired: has("DUO:0000019"),
		publicationMoratorium: has("DUO:0000024"),
		ethicsApprovalRequired: has("DUO:0000021"),
		collaborationRequired: has("DUO:0000020"),
		geographicRestriction: has("DUO:0000022"),
		returnToResource: has("DUO:0000029"),
		hasRestrictions: [...present].some(
			(code) => DUO_TERMS[code]?.kind === "modifier",
		),
	};
}

/**
 * A one-line human summary, for surfacing beside the licence in a Sources panel.
 * Returns undefined when there is nothing to say.
 */
export function summariseDuoCodes(codes: readonly string[]): string | undefined {
	const normalized = normalizeDuoCodes(codes);
	if (normalized.length === 0) return undefined;
	return normalized
		.map((code) => {
			const term = DUO_TERMS[code];
			return term?.shorthand ? `${term.shorthand} (${term.label})` : code;
		})
		.join("; ");
}
