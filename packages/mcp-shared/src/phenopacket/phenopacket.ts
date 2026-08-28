/**
 * GA4GH Phenopacket v2 construction.
 *
 * Our phenotype work (monarch, decipher, omim, hpo) currently emits ad-hoc JSON
 * that only this fleet understands. A Phenopacket is the standard container for
 * the same content, so a result can be handed to external clinical tooling
 * without a bespoke adapter.
 *
 * The part that is easy to get wrong, and that this module exists to get right:
 * `metaData.resources` MUST declare every ontology the packet references. A
 * packet citing `HP:0001250` without declaring HPO is not interpretable — the
 * CURIE cannot be resolved to an IRI. Resources are therefore derived from the
 * CURIEs actually used rather than left to the caller.
 */

export const PHENOPACKET_SCHEMA_VERSION = "2.0";

export interface OntologyClass {
	id: string;
	label?: string;
}

export interface Resource {
	id: string;
	name: string;
	url: string;
	version: string;
	namespacePrefix: string;
	iriPrefix: string;
}

export type Sex = "MALE" | "FEMALE" | "OTHER_SEX" | "UNKNOWN_SEX";

export interface Individual {
	id: string;
	sex?: Sex;
	timeAtLastEncounter?: { age: { iso8601duration: string } };
	taxonomy?: OntologyClass;
}

export interface PhenotypicFeature {
	type: OntologyClass;
	excluded?: boolean;
	onset?: { age: { iso8601duration: string } };
}

export interface Disease {
	term: OntologyClass;
	excluded?: boolean;
}

export interface MetaData {
	created: string;
	createdBy: string;
	resources: Resource[];
	phenopacketSchemaVersion: string;
}

export interface Phenopacket {
	id: string;
	subject?: Individual;
	phenotypicFeatures?: PhenotypicFeature[];
	diseases?: Disease[];
	metaData: MetaData;
}

export class PhenopacketError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "PhenopacketError";
		this.code = code;
	}
}

/**
 * OBO-library ontologies share one IRI scheme, so their resource entries are
 * derived rather than transcribed — one less table to get wrong.
 */
const OBO_ONTOLOGIES: Readonly<Record<string, string>> = {
	HP: "human phenotype ontology",
	MONDO: "Mondo Disease Ontology",
	NCIT: "NCI Thesaurus",
	UBERON: "Uber-anatomy ontology",
	GENO: "Genotype Ontology",
	SO: "Sequence types and features ontology",
	MAXO: "Medical Action Ontology",
	NCBITaxon: "NCBI organismal classification",
	CHEBI: "Chemical Entities of Biological Interest",
	ECO: "Evidence and Conclusion Ontology",
};

/** Ontologies that do not follow the OBO IRI scheme. */
const NON_OBO_RESOURCES: Readonly<Record<string, Omit<Resource, "version">>> = {
	OMIM: {
		id: "omim",
		name: "An Online Catalog of Human Genes and Genetic Disorders",
		url: "https://www.omim.org",
		namespacePrefix: "OMIM",
		iriPrefix: "https://omim.org/entry/",
	},
	ORPHA: {
		id: "orphanet",
		name: "Orphanet",
		url: "https://www.orpha.net",
		namespacePrefix: "ORPHA",
		iriPrefix: "https://www.orpha.net/ORDO/Orphanet_",
	},
	HGNC: {
		id: "hgnc",
		name: "HUGO Gene Nomenclature Committee",
		url: "https://www.genenames.org",
		namespacePrefix: "HGNC",
		iriPrefix: "https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/",
	},
};

function oboResource(prefix: string, version: string): Resource {
	return {
		id: prefix.toLowerCase(),
		name: OBO_ONTOLOGIES[prefix],
		url: `http://purl.obolibrary.org/obo/${prefix.toLowerCase()}.owl`,
		version,
		namespacePrefix: prefix,
		iriPrefix: `http://purl.obolibrary.org/obo/${prefix}_`,
	};
}

/** The prefix of a CURIE such as `HP:0001250`. */
export function curiePrefix(curie: string): string {
	const separator = curie.indexOf(":");
	if (separator <= 0) {
		throw new PhenopacketError(
			"INVALID_CURIE",
			`Not a CURIE (expected PREFIX:LOCAL): ${curie}`,
		);
	}
	return curie.slice(0, separator);
}

export function isKnownPrefix(prefix: string): boolean {
	return prefix in OBO_ONTOLOGIES || prefix in NON_OBO_RESOURCES;
}

/**
 * Build the resource entries for a set of CURIEs. Throws on a prefix we cannot
 * describe: emitting a packet that references an undeclared ontology would
 * produce a document that looks valid and cannot actually be resolved.
 */
export function resourcesForCuries(
	curies: readonly string[],
	versions: Readonly<Record<string, string>> = {},
): Resource[] {
	const prefixes = [...new Set(curies.map(curiePrefix))].sort();
	return prefixes.map((prefix) => {
		const version = versions[prefix] ?? "unknown";
		if (prefix in OBO_ONTOLOGIES) return oboResource(prefix, version);
		const nonObo = NON_OBO_RESOURCES[prefix];
		if (!nonObo) {
			throw new PhenopacketError(
				"UNKNOWN_ONTOLOGY_PREFIX",
				`No resource descriptor for CURIE prefix "${prefix}". A phenopacket must declare every ontology it references.`,
			);
		}
		return { ...nonObo, version };
	});
}

export interface ToPhenopacketInput {
	id: string;
	subject?: Individual;
	phenotypicFeatures?: PhenotypicFeature[];
	diseases?: Disease[];
	createdBy?: string;
	/** ISO-8601 creation timestamp. Injected so packets are reproducible. */
	created: string;
	/** Ontology versions keyed by CURIE prefix, e.g. `{ HP: "2024-04-26" }`. */
	ontologyVersions?: Record<string, string>;
}

function collectCuries(input: ToPhenopacketInput): string[] {
	const curies: string[] = [];
	for (const feature of input.phenotypicFeatures ?? []) {
		curies.push(feature.type.id);
	}
	for (const disease of input.diseases ?? []) curies.push(disease.term.id);
	if (input.subject?.taxonomy) curies.push(input.subject.taxonomy.id);
	return curies;
}

/**
 * Assemble a Phenopacket, deriving `metaData.resources` from the CURIEs used.
 */
export function toPhenopacket(input: ToPhenopacketInput): Phenopacket {
	if (!input.id) {
		throw new PhenopacketError("MISSING_ID", "A phenopacket requires an id.");
	}
	const resources = resourcesForCuries(
		collectCuries(input),
		input.ontologyVersions,
	);
	return {
		id: input.id,
		...(input.subject ? { subject: input.subject } : {}),
		...(input.phenotypicFeatures?.length
			? { phenotypicFeatures: input.phenotypicFeatures }
			: {}),
		...(input.diseases?.length ? { diseases: input.diseases } : {}),
		metaData: {
			created: input.created,
			createdBy: input.createdBy ?? "bio-mcp",
			resources,
			phenopacketSchemaVersion: PHENOPACKET_SCHEMA_VERSION,
		},
	};
}

/**
 * Structural validation of a packet we produced or received. Checks the
 * invariants a consumer depends on, chiefly that every referenced ontology is
 * declared in metaData.resources.
 */
export function validatePhenopacket(packet: Phenopacket): string[] {
	const problems: string[] = [];
	if (!packet.id) problems.push("missing id");
	if (!packet.metaData) {
		problems.push("missing metaData");
		return problems;
	}
	if (!packet.metaData.created) problems.push("missing metaData.created");
	if (packet.metaData.phenopacketSchemaVersion !== PHENOPACKET_SCHEMA_VERSION) {
		problems.push(
			`unexpected schema version ${packet.metaData.phenopacketSchemaVersion}`,
		);
	}
	const declared = new Set(
		(packet.metaData.resources ?? []).map(
			(resource) => resource.namespacePrefix,
		),
	);
	const referenced = new Set<string>();
	for (const feature of packet.phenotypicFeatures ?? []) {
		referenced.add(curiePrefix(feature.type.id));
	}
	for (const disease of packet.diseases ?? []) {
		referenced.add(curiePrefix(disease.term.id));
	}
	for (const prefix of [...referenced].sort()) {
		if (!declared.has(prefix)) {
			problems.push(`undeclared ontology ${prefix} in metaData.resources`);
		}
	}
	return problems;
}
