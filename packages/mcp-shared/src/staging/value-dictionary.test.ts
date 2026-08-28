import { describe, expect, it } from "vitest";
import {
	countDictionaryEntries,
	declareValueDictionary,
	findLabelPairs,
	inferValueDictionaries,
	mergeValueDictionaries,
} from "./value-dictionary";

/** Shaped after the dbGaP childhood-asthma table: codes plus a label sibling. */
const ASTHMA_ROWS = [
	{ patient: "p1", treatment_group: 1, treatment_group_label: "albuterol" },
	{ patient: "p2", treatment_group: 2, treatment_group_label: "azithromycin" },
	{ patient: "p3", treatment_group: 1, treatment_group_label: "albuterol" },
];

describe("findLabelPairs", () => {
	it("pairs a code column with its snake_case label sibling", () => {
		const pairs = findLabelPairs(["sex", "sex_label", "age"]);
		expect(pairs.get("sex")).toBe("sex_label");
		expect(pairs.has("age")).toBe(false);
	});

	it("pairs across naming conventions", () => {
		expect(
			findLabelPairs(["treatmentGroup", "treatmentGroupName"]).get(
				"treatmentGroup",
			),
		).toBe("treatmentGroupName");
		expect(findLabelPairs(["status", "statusDisplay"]).get("status")).toBe(
			"statusDisplay",
		);
		expect(findLabelPairs(["code", "code_description"]).get("code")).toBe(
			"code_description",
		);
	});

	it("never pairs a column with itself", () => {
		expect(findLabelPairs(["name"]).has("name")).toBe(false);
	});

	it("returns nothing when no sibling looks like a label", () => {
		expect(findLabelPairs(["a", "b", "c"]).size).toBe(0);
	});
});

describe("inferValueDictionaries", () => {
	it("recovers the code→label mapping from paired columns", () => {
		const dictionaries = inferValueDictionaries(ASTHMA_ROWS);
		expect(dictionaries.treatment_group).toEqual({
			values: { "1": "albuterol", "2": "azithromycin" },
			source: "paired_column",
			label_column: "treatment_group_label",
		});
	});

	it("returns nothing for an empty row set", () => {
		expect(inferValueDictionaries([])).toEqual({});
	});

	it("drops a column whose code maps to conflicting labels", () => {
		const dictionaries = inferValueDictionaries([
			{ sex: 1, sex_label: "female" },
			{ sex: 1, sex_label: "male" },
		]);
		expect(dictionaries.sex).toBeUndefined();
	});

	it("drops an identity mapping that would teach a reader nothing", () => {
		const dictionaries = inferValueDictionaries([
			{ status: "ACTIVE", status_label: "ACTIVE" },
			{ status: "CLOSED", status_label: "closed" },
		]);
		expect(dictionaries.status).toBeUndefined();
	});

	it("keeps a mapping where only some entries coincide with their code", () => {
		const dictionaries = inferValueDictionaries([
			{ status: "ACTIVE", status_label: "ACTIVE" },
			{ status: "C", status_label: "Completed" },
		]);
		expect(dictionaries.status?.values).toEqual({
			ACTIVE: "ACTIVE",
			C: "Completed",
		});
	});

	it("ignores rows with a missing code or a missing label", () => {
		const dictionaries = inferValueDictionaries([
			{ sex: 1, sex_label: "female" },
			{ sex: 2, sex_label: null },
			{ sex: null, sex_label: "male" },
		]);
		expect(dictionaries.sex?.values).toEqual({ "1": "female" });
	});

	it("handles ragged rows that do not all share the same columns", () => {
		const dictionaries = inferValueDictionaries([
			{ sex: 1 },
			{ sex: 2, sex_label: "male" },
		]);
		expect(dictionaries.sex?.values).toEqual({ "2": "male" });
	});

	it("treats boolean codes as codes", () => {
		const dictionaries = inferValueDictionaries([
			{ flag: true, flag_label: "affected" },
			{ flag: false, flag_label: "unaffected" },
		]);
		expect(dictionaries.flag?.values).toEqual({
			true: "affected",
			false: "unaffected",
		});
	});

	it("abandons a column with more distinct codes than an enumeration would have", () => {
		const rows = Array.from({ length: 250 }, (_, index) => ({
			id: index,
			id_name: `label-${index}`,
		}));
		expect(inferValueDictionaries(rows).id).toBeUndefined();
	});

	it("leaves unpaired columns alone", () => {
		const dictionaries = inferValueDictionaries([
			{
				patient: "p1",
				age: 40,
				treatment_group: 1,
				treatment_group_label: "x",
			},
		]);
		expect(Object.keys(dictionaries)).toEqual(["treatment_group"]);
	});
});

describe("mergeValueDictionaries", () => {
	it("returns the inferred set when nothing was declared", () => {
		const inferred = inferValueDictionaries(ASTHMA_ROWS);
		expect(mergeValueDictionaries(inferred, undefined)).toBe(inferred);
	});

	it("lets a declared dictionary win over an inferred one", () => {
		const inferred = inferValueDictionaries(ASTHMA_ROWS);
		const merged = mergeValueDictionaries(inferred, {
			treatment_group: declareValueDictionary({ 1: "Albuterol (RxNorm 435)" }),
		});
		expect(merged.treatment_group.source).toBe("declared");
		expect(merged.treatment_group.values["1"]).toBe("Albuterol (RxNorm 435)");
	});

	it("keeps inferred dictionaries for columns the declaration does not cover", () => {
		const merged = mergeValueDictionaries(inferValueDictionaries(ASTHMA_ROWS), {
			other: declareValueDictionary({ 9: "nine" }),
		});
		expect(Object.keys(merged).sort()).toEqual(["other", "treatment_group"]);
	});
});

describe("declareValueDictionary", () => {
	it("stringifies numeric labels and marks the source as declared", () => {
		expect(declareValueDictionary({ 0: 0, 1: "one" })).toEqual({
			values: { "0": "0", "1": "one" },
			source: "declared",
		});
	});
});

describe("countDictionaryEntries", () => {
	it("sums entries across every column", () => {
		expect(countDictionaryEntries(inferValueDictionaries(ASTHMA_ROWS))).toBe(2);
	});

	it("is zero for an empty dictionary set", () => {
		expect(countDictionaryEntries({})).toBe(0);
	});
});
