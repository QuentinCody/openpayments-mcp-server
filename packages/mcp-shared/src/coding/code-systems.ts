/**
 * Registry of canonical CodeSystem URIs used in biomedical data.
 *
 * These URI strings are HL7-published terminology identifiers and are not
 * themselves licensable — only the underlying code dictionaries carry license
 * obligations. See `NOTICE.md` at the package root for attribution rules
 * around bundled dictionaries.
 *
 * Pattern derived from shc-web-reader/src/lib/codes.js:19-106 (MIT © 2023
 * The Commons Project), expanded with biomedical-specific systems used across
 * our MCP server fleet (gene/variant/drug ontologies in addition to FHIR
 * clinical systems).
 */

/** Top-level controlled-vocabulary system descriptor. */
export interface CodeSystemDescriptor {
	/** Canonical URI as published by the issuing organization. */
	uri: string;
	/** Short human-readable identifier (e.g., "loinc", "snomed"). */
	id: string;
	/** Long-form name. */
	name: string;
	/** Short description for UI / docs. */
	description?: string;
	/** Original specification or browse URL. */
	homepage?: string;
	/** Free-text license summary. */
	license?: string;
	/** Where dictionaries can be downloaded if the source is freely available. */
	dictUrl?: string;
}

/**
 * Canonical clinical-terminology systems (FHIR-published URIs).
 */
export const CLINICAL_SYSTEMS = {
	loinc: {
		uri: "http://loinc.org",
		id: "loinc",
		name: "Logical Observation Identifiers Names and Codes",
		description: "Lab tests, vitals, and clinical observations",
		homepage: "https://loinc.org",
		license: "Free under LOINC license — attribution required",
	},
	snomed: {
		uri: "http://snomed.info/sct",
		id: "snomed",
		name: "SNOMED CT",
		description: "Clinical terminology for diagnoses, findings, procedures",
		homepage: "https://www.snomed.org",
		license: "Affiliate license required; Global Patient Set available CC-BY 4.0",
	},
	icd10cm: {
		uri: "http://hl7.org/fhir/sid/icd-10-cm",
		id: "icd10cm",
		name: "ICD-10-CM",
		description: "International Classification of Diseases, Clinical Modification (US)",
		homepage: "https://www.cdc.gov/nchs/icd/icd10cm.htm",
		license: "Public domain (US Government)",
	},
	icd10: {
		uri: "http://hl7.org/fhir/sid/icd-10",
		id: "icd10",
		name: "ICD-10",
		description: "WHO International Classification of Diseases",
		homepage: "https://www.who.int/classifications/icd",
		license: "WHO terms; non-commercial use generally permitted",
	},
	icd11: {
		uri: "http://id.who.int/icd/release/11/mms",
		id: "icd11",
		name: "ICD-11",
		description: "WHO International Classification of Diseases, 11th revision",
		homepage: "https://icd.who.int/en",
		license: "WHO terms; CC BY-ND 3.0 IGO",
	},
	rxnorm: {
		uri: "http://www.nlm.nih.gov/research/umls/rxnorm",
		id: "rxnorm",
		name: "RxNorm",
		description: "Clinical drug terminology from the US NLM",
		homepage: "https://www.nlm.nih.gov/research/umls/rxnorm/",
		license: "Public domain (US Government)",
	},
	atc: {
		uri: "http://www.whocc.no/atc",
		id: "atc",
		name: "WHO ATC",
		description: "Anatomical Therapeutic Chemical Classification",
		homepage: "https://www.whocc.no/atc_ddd_index/",
		license: "WHO terms; non-commercial reuse permitted",
	},
	cpt: {
		uri: "http://www.ama-assn.org/go/cpt",
		id: "cpt",
		name: "CPT",
		description: "Current Procedural Terminology (AMA)",
		homepage: "https://www.ama-assn.org/practice-management/cpt",
		license: "AMA — commercial license required for full code set",
	},
	cvx: {
		uri: "http://hl7.org/fhir/sid/cvx",
		id: "cvx",
		name: "CVX",
		description: "Vaccine codes (CDC)",
		homepage: "https://www.cdc.gov/vaccines/programs/iis/code-sets.html",
		license: "Public domain (US Government)",
	},
	ndc: {
		uri: "http://hl7.org/fhir/sid/ndc",
		id: "ndc",
		name: "NDC",
		description: "National Drug Code (FDA)",
		homepage: "https://www.fda.gov/drugs/drug-approvals-and-databases/national-drug-code-directory",
		license: "Public domain (US Government)",
	},
	ucum: {
		uri: "http://unitsofmeasure.org",
		id: "ucum",
		name: "UCUM",
		description: "Unified Code for Units of Measure",
		homepage: "https://ucum.org",
		license: "Free under UCUM license",
	},
} as const satisfies Record<string, CodeSystemDescriptor>;

/**
 * FHIR terminology infrastructure systems (used inside Coding/CodeableConcept).
 */
export const FHIR_INFRA_SYSTEMS = {
	conditionClinical: {
		uri: "http://terminology.hl7.org/CodeSystem/condition-clinical",
		id: "conditionClinical",
		name: "FHIR Condition Clinical Status",
	},
	conditionVer: {
		uri: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
		id: "conditionVer",
		name: "FHIR Condition Verification Status",
	},
	allergyClinical: {
		uri: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
		id: "allergyClinical",
		name: "FHIR AllergyIntolerance Clinical Status",
	},
	allergyVer: {
		uri: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
		id: "allergyVer",
		name: "FHIR AllergyIntolerance Verification Status",
	},
	observationCategory: {
		uri: "http://terminology.hl7.org/CodeSystem/observation-category",
		id: "observationCategory",
		name: "FHIR Observation Category",
	},
	observationInterpretation: {
		uri: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
		id: "observationInterpretation",
		name: "v3 Observation Interpretation",
	},
	coverageClass: {
		uri: "http://terminology.hl7.org/CodeSystem/coverage-class",
		id: "coverageClass",
		name: "FHIR Coverage Class",
	},
	coverageCopayType: {
		uri: "http://terminology.hl7.org/CodeSystem/coverage-copay-type",
		id: "coverageCopayType",
		name: "FHIR Coverage Copay Type",
	},
	contactEntityType: {
		uri: "http://terminology.hl7.org/CodeSystem/contactentity-type",
		id: "contactEntityType",
		name: "FHIR Contact Entity Type",
	},
	consentScope: {
		uri: "http://terminology.hl7.org/CodeSystem/consentscope",
		id: "consentScope",
		name: "FHIR Consent Scope",
	},
	consentPolicy: {
		uri: "http://terminology.hl7.org/CodeSystem/consentpolicycodes",
		id: "consentPolicy",
		name: "FHIR Consent Policy",
	},
	consentCategory: {
		uri: "http://terminology.hl7.org/CodeSystem/consentcategorycodes",
		id: "consentCategory",
		name: "FHIR Consent Category",
	},
	substanceAdminSubstitution: {
		uri: "http://terminology.hl7.org/CodeSystem/v3-substanceAdminSubstitution",
		id: "substanceAdminSubstitution",
		name: "v3 Substance Admin Substitution",
	},
} as const satisfies Record<string, CodeSystemDescriptor>;

/**
 * Genetic and drug-discovery systems used by MCP servers like clinvar, gnomad,
 * civic, dgidb, opentargets, ensembl, hgnc, biothings.
 */
export const BIOMEDICAL_SYSTEMS = {
	hgnc: {
		uri: "http://www.genenames.org/geneId",
		id: "hgnc",
		name: "HGNC Gene Symbols",
		homepage: "https://www.genenames.org",
		license: "CC0 (public domain)",
	},
	entrezGene: {
		uri: "http://www.ncbi.nlm.nih.gov/gene",
		id: "entrezGene",
		name: "NCBI Entrez Gene",
		homepage: "https://www.ncbi.nlm.nih.gov/gene",
		license: "Public domain (US Government)",
	},
	ensembl: {
		uri: "http://www.ensembl.org",
		id: "ensembl",
		name: "Ensembl Gene/Transcript IDs",
		homepage: "https://www.ensembl.org",
	},
	uniprot: {
		uri: "http://www.uniprot.org/uniprot",
		id: "uniprot",
		name: "UniProt",
		homepage: "https://www.uniprot.org",
		license: "CC BY 4.0",
	},
	chembl: {
		uri: "https://www.ebi.ac.uk/chembl",
		id: "chembl",
		name: "ChEMBL Compound Identifiers",
		homepage: "https://www.ebi.ac.uk/chembl/",
		license: "CC BY-SA 3.0",
	},
	chebi: {
		uri: "http://purl.obolibrary.org/obo/CHEBI",
		id: "chebi",
		name: "ChEBI — Chemical Entities of Biological Interest",
		homepage: "https://www.ebi.ac.uk/chebi/",
	},
	clinvar: {
		uri: "https://www.ncbi.nlm.nih.gov/clinvar",
		id: "clinvar",
		name: "ClinVar Variants",
		homepage: "https://www.ncbi.nlm.nih.gov/clinvar/",
		license: "Public domain (US Government)",
	},
	mondo: {
		uri: "http://purl.obolibrary.org/obo/mondo.owl",
		id: "mondo",
		name: "Monarch Disease Ontology",
		homepage: "https://mondo.monarchinitiative.org",
	},
	hpo: {
		uri: "http://human-phenotype-ontology.org",
		id: "hpo",
		name: "Human Phenotype Ontology",
		homepage: "https://hpo.jax.org",
	},
	mesh: {
		uri: "http://id.nlm.nih.gov/mesh",
		id: "mesh",
		name: "Medical Subject Headings (MeSH)",
		homepage: "https://www.nlm.nih.gov/mesh/meshhome.html",
		license: "Public domain (US Government)",
	},
} as const satisfies Record<string, CodeSystemDescriptor>;

/** All known systems flattened by URI for runtime lookup. */
export const SYSTEMS_BY_URI: Readonly<Record<string, CodeSystemDescriptor>> = (() => {
	const out: Record<string, CodeSystemDescriptor> = {};
	for (const group of [CLINICAL_SYSTEMS, FHIR_INFRA_SYSTEMS, BIOMEDICAL_SYSTEMS]) {
		for (const desc of Object.values(group)) {
			out[desc.uri] = desc;
		}
	}
	return Object.freeze(out);
})();

/** Lookup a system descriptor by its canonical URI, returning undefined if unknown. */
export function getSystemDescriptor(uri: string): CodeSystemDescriptor | undefined {
	return SYSTEMS_BY_URI[uri];
}

/** Return the short id of a system from its canonical URI. */
export function getSystemId(uri: string): string | undefined {
	return SYSTEMS_BY_URI[uri]?.id;
}
