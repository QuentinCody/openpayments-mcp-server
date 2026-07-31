import { describe, expect, it } from "vitest";
import {
	formatFieldSuggestions,
	rankFieldNames,
	relevanceScore,
} from "./field-suggestions";

// The exact field sets CIViC returned on bio.quentincody.dev (2026-07-31), in
// the declaration order the old code truncated by. Both live failures are
// pinned below as regressions.
const EVIDENCE_ITEM_FIELDS = [
	"acceptanceEvent",
	"assertions",
	"comments",
	"description",
	"descriptionReplaceEidWithSource",
	"descriptionWithNames",
	"descriptionWithNamesReplaceEidWithSource",
	"descriptionWithTags",
	"descriptionWithTagsReplaceEidWithSource",
	"disease",
	"events",
	"evidenceDirection",
	"evidenceLevel",
	"evidenceRating",
	"evidenceType",
	"id",
	"molecularProfile",
	"name",
	"phenotypes",
	"rejectionEvent",
	"significance",
	"source",
	"status",
	"submissionEvent",
	"therapies",
	"therapyInteractionType",
	"variantOrigin",
];

const VARIANT_INTERFACE_FIELDS = [
	"clinicalSignificanceCounts",
	"comments",
	"creationActivity",
	"deprecated",
	"deprecationActivity",
	"deprecationReason",
	"detailedClinicalSignificanceCounts",
	"events",
	"feature",
	"flagged",
	"flags",
	"id",
	"lastAcceptedRevisionEvent",
	"lastSubmittedRevisionEvent",
	"link",
	"molecularProfiles",
	"name",
	"openRevisionCount",
	"revisions",
	"singleVariantMolecularProfile",
	"singleVariantMolecularProfileId",
	"variantAliases",
	"variantTypes",
	"webUrl",
];

const score = (candidate: string, rejected: string) =>
	relevanceScore({ candidate, rejected });

describe("relevanceScore", () => {
	it("ranks a case-only difference highest", () => {
		expect(score("clinicalSignificance", "clinicalsignificance")).toBe(3000);
	});

	it("ranks containment above any edit-distance match", () => {
		const contained = score("significance", "clinicalSignificance");
		const merelySimilar = score("assertions", "clinicalSignificance");
		expect(contained).toBeGreaterThan(merelySimilar);
		expect(contained).toBeGreaterThan(2000);
	});

	it("prefers the longer overlap among containment matches", () => {
		// Both are substrings of the rejected name; `significance` shares far more.
		expect(score("significance", "clinicalSignificance")).toBeGreaterThan(
			score("nic", "clinicalSignificance"),
		);
	});

	it("scores an unrelated name low", () => {
		expect(score("webUrl", "clinicalSignificance")).toBeLessThan(500);
	});

	it("does not produce NaN for two empty strings", () => {
		expect(Number.isFinite(score("", ""))).toBe(true);
	});

	it("does not produce NaN when one side is empty", () => {
		expect(Number.isFinite(score("", "significance"))).toBe(true);
	});
});

describe("rankFieldNames", () => {
	it("is deterministic for equally-scored names", () => {
		const once = rankFieldNames(EVIDENCE_ITEM_FIELDS, "zzzz", 5);
		const twice = rankFieldNames(EVIDENCE_ITEM_FIELDS, "zzzz", 5);
		expect(once).toEqual(twice);
	});

	it("never returns more than the limit", () => {
		expect(rankFieldNames(EVIDENCE_ITEM_FIELDS, "significance", 3)).toHaveLength(
			3,
		);
	});
});

describe("formatFieldSuggestions — live regressions", () => {
	// REGRESSION (bio.quentincody.dev, 2026-07-31): the model asked for
	// `clinicalSignificance` on EvidenceItem. The real field is `significance`,
	// and declaration-order truncation at 12 cut the list off at
	// `evidenceDirection` — hiding it. The model guessed again and burned a call.
	it("surfaces `significance` for a caller who asked for `clinicalSignificance`", () => {
		const hint = formatFieldSuggestions(
			EVIDENCE_ITEM_FIELDS,
			"clinicalSignificance",
			12,
		);
		expect(hint).toContain("significance");
		// And it leads, rather than being buried at the end of the budget.
		expect(hint.split(", ")[0]).toBe("significance");
	});

	// REGRESSION: `evidenceItems` on VariantInterface fell in the hidden tail.
	it("surfaces the closest match for `evidenceItems`", () => {
		const hint = formatFieldSuggestions(
			VARIANT_INTERFACE_FIELDS,
			"evidenceItems",
			12,
		);
		expect(hint).toContain("events");
	});

	it("still reports how many were withheld", () => {
		const hint = formatFieldSuggestions(
			EVIDENCE_ITEM_FIELDS,
			"clinicalSignificance",
			12,
		);
		expect(hint).toContain(`(+${EVIDENCE_ITEM_FIELDS.length - 12} more`);
		expect(hint).toContain("closest listed first");
	});

	it("lists every field verbatim when the type is small enough", () => {
		expect(formatFieldSuggestions(["id", "name"], "gene", 12)).toBe("id, name");
	});

	it("does not truncate at exactly the limit", () => {
		const twelve = EVIDENCE_ITEM_FIELDS.slice(0, 12);
		expect(formatFieldSuggestions(twelve, "gene", 12)).toBe(twelve.join(", "));
	});
});
