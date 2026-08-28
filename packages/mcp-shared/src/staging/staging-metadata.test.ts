import { describe, expect, it } from "vitest";
import { buildStagingMetadata } from "./staging-metadata";
import {
	declareValueDictionary,
	inferValueDictionaries,
} from "./value-dictionary";

const base = { dataAccessId: "abc123", tables: ["main"], toolPrefix: "ctgov" };

describe("buildStagingMetadata", () => {
	it("derives the query and schema tool names from the prefix", () => {
		const metadata = buildStagingMetadata(base);
		expect(metadata.query_tool).toBe("ctgov_query_data");
		expect(metadata.schema_tool).toBe("ctgov_get_schema");
		expect(metadata.staged).toBe(true);
	});

	it("defaults the primary table to the first table", () => {
		expect(
			buildStagingMetadata({ ...base, tables: ["a", "b"] }).primary_table,
		).toBe("a");
	});

	it("omits value_dictionaries when none were supplied", () => {
		expect(buildStagingMetadata(base).value_dictionaries).toBeUndefined();
	});

	it("omits value_dictionaries when the supplied set is empty", () => {
		expect(
			buildStagingMetadata({ ...base, valueDictionaries: {} })
				.value_dictionaries,
		).toBeUndefined();
	});

	it("carries inferred dictionaries through, keyed by table", () => {
		const dictionaries = {
			main: inferValueDictionaries([
				{ sex: 1, sex_label: "female" },
				{ sex: 2, sex_label: "male" },
			]),
		};
		const metadata = buildStagingMetadata({
			...base,
			valueDictionaries: dictionaries,
		});
		expect(metadata.value_dictionaries?.main.sex.values).toEqual({
			"1": "female",
			"2": "male",
		});
	});

	it("carries declared dictionaries through unchanged", () => {
		const metadata = buildStagingMetadata({
			...base,
			valueDictionaries: {
				main: { status: declareValueDictionary({ 0: "unknown", 1: "active" }) },
			},
		});
		expect(metadata.value_dictionaries?.main.status).toEqual({
			values: { "0": "unknown", "1": "active" },
			source: "declared",
		});
	});
});
