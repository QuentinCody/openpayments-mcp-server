import { describe, expect, it } from "vitest";
import {
	curiePrefix,
	isKnownPrefix,
	PHENOPACKET_SCHEMA_VERSION,
	type Phenopacket,
	PhenopacketError,
	resourcesForCuries,
	toPhenopacket,
	validatePhenopacket,
} from "./phenopacket";

const CREATED = "2026-08-04T12:00:00Z";

const seizureAndDisease = {
	id: "packet-1",
	created: CREATED,
	phenotypicFeatures: [{ type: { id: "HP:0001250", label: "Seizure" } }],
	diseases: [{ term: { id: "MONDO:0005027", label: "epilepsy" } }],
};

describe("curiePrefix", () => {
	it("extracts the prefix", () => {
		expect(curiePrefix("HP:0001250")).toBe("HP");
		expect(curiePrefix("NCBITaxon:9606")).toBe("NCBITaxon");
	});

	it("rejects a value that is not a CURIE", () => {
		expect(() => curiePrefix("0001250")).toThrow(PhenopacketError);
		expect(() => curiePrefix(":0001250")).toThrow(/Not a CURIE/);
	});
});

describe("isKnownPrefix", () => {
	it("knows OBO and non-OBO ontologies we emit", () => {
		expect(isKnownPrefix("HP")).toBe(true);
		expect(isKnownPrefix("MONDO")).toBe(true);
		expect(isKnownPrefix("OMIM")).toBe(true);
		expect(isKnownPrefix("ORPHA")).toBe(true);
	});

	it("does not claim to know an arbitrary prefix", () => {
		expect(isKnownPrefix("NOTANONTOLOGY")).toBe(false);
	});
});

describe("resourcesForCuries", () => {
	it("derives the OBO IRI scheme for an OBO ontology", () => {
		const [resource] = resourcesForCuries(["HP:0001250"]);
		expect(resource).toEqual({
			id: "hp",
			name: "human phenotype ontology",
			url: "http://purl.obolibrary.org/obo/hp.owl",
			version: "unknown",
			namespacePrefix: "HP",
			iriPrefix: "http://purl.obolibrary.org/obo/HP_",
		});
	});

	it("uses the transcribed descriptor for a non-OBO ontology", () => {
		const [resource] = resourcesForCuries(["OMIM:143100"]);
		expect(resource.namespacePrefix).toBe("OMIM");
		expect(resource.iriPrefix).toBe("https://omim.org/entry/");
	});

	it("de-duplicates and orders prefixes", () => {
		const resources = resourcesForCuries([
			"MONDO:1",
			"HP:2",
			"HP:3",
			"MONDO:4",
		]);
		expect(resources.map((r) => r.namespacePrefix)).toEqual(["HP", "MONDO"]);
	});

	it("applies a supplied ontology version", () => {
		const [resource] = resourcesForCuries(["HP:0001250"], { HP: "2024-04-26" });
		expect(resource.version).toBe("2024-04-26");
	});

	it("refuses a prefix it cannot describe rather than emitting an unresolvable packet", () => {
		expect(() => resourcesForCuries(["WAT:0001"])).toThrow(
			/must declare every ontology/,
		);
	});
});

describe("toPhenopacket", () => {
	it("declares a resource for every ontology referenced", () => {
		const packet = toPhenopacket(seizureAndDisease);
		expect(packet.metaData.resources.map((r) => r.namespacePrefix)).toEqual([
			"HP",
			"MONDO",
		]);
	});

	it("stamps the schema version and the injected creation time", () => {
		const packet = toPhenopacket(seizureAndDisease);
		expect(packet.metaData.phenopacketSchemaVersion).toBe(
			PHENOPACKET_SCHEMA_VERSION,
		);
		expect(packet.metaData.created).toBe(CREATED);
	});

	it("is reproducible for the same input", () => {
		expect(JSON.stringify(toPhenopacket(seizureAndDisease))).toBe(
			JSON.stringify(toPhenopacket(seizureAndDisease)),
		);
	});

	it("defaults createdBy but honours an override", () => {
		expect(toPhenopacket(seizureAndDisease).metaData.createdBy).toBe("bio-mcp");
		expect(
			toPhenopacket({ ...seizureAndDisease, createdBy: "monarch" }).metaData
				.createdBy,
		).toBe("monarch");
	});

	it("omits empty optional sections rather than emitting empty arrays", () => {
		const packet = toPhenopacket({ id: "p", created: CREATED });
		expect(packet.phenotypicFeatures).toBeUndefined();
		expect(packet.diseases).toBeUndefined();
		expect(packet.subject).toBeUndefined();
		expect(packet.metaData.resources).toEqual([]);
	});

	it("carries an excluded phenotype through", () => {
		const packet = toPhenopacket({
			id: "p",
			created: CREATED,
			phenotypicFeatures: [{ type: { id: "HP:0001250" }, excluded: true }],
		});
		expect(packet.phenotypicFeatures?.[0].excluded).toBe(true);
	});

	it("declares the taxonomy ontology when a subject taxon is given", () => {
		const packet = toPhenopacket({
			id: "p",
			created: CREATED,
			subject: { id: "patient-1", taxonomy: { id: "NCBITaxon:9606" } },
		});
		expect(packet.metaData.resources[0].namespacePrefix).toBe("NCBITaxon");
	});

	it("rejects a packet with no id", () => {
		expect(() => toPhenopacket({ id: "", created: CREATED })).toThrow(
			/requires an id/,
		);
	});
});

describe("validatePhenopacket", () => {
	it("passes a packet built by toPhenopacket", () => {
		expect(validatePhenopacket(toPhenopacket(seizureAndDisease))).toEqual([]);
	});

	it("catches an ontology referenced but not declared", () => {
		const packet = toPhenopacket(seizureAndDisease);
		packet.metaData.resources = packet.metaData.resources.filter(
			(r) => r.namespacePrefix !== "MONDO",
		);
		expect(validatePhenopacket(packet)).toContain(
			"undeclared ontology MONDO in metaData.resources",
		);
	});

	it("catches a missing id and a missing created timestamp", () => {
		const packet = toPhenopacket(seizureAndDisease);
		packet.id = "";
		packet.metaData.created = "";
		const problems = validatePhenopacket(packet);
		expect(problems).toContain("missing id");
		expect(problems).toContain("missing metaData.created");
	});

	it("catches a wrong schema version", () => {
		const packet = toPhenopacket(seizureAndDisease);
		packet.metaData.phenopacketSchemaVersion = "1.0";
		expect(validatePhenopacket(packet)).toContain(
			"unexpected schema version 1.0",
		);
	});

	it("reports missing metaData without throwing", () => {
		// SAFETY: deliberately malformed — the point of the test is that
		// validatePhenopacket reports missing metaData instead of throwing.
		const packet = { id: "p" } as unknown as Phenopacket;
		expect(validatePhenopacket(packet)).toEqual(["missing metaData"]);
	});
});
