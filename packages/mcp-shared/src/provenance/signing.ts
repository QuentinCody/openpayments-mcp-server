/** Compatibility facade; implementation is versioned in provenance-core. */
export {
	buildJwks,
	CITATION_SIG_ALG,
	citationSigningInput,
	exportCitationPublicJwk,
	generateCitationKeypair,
	importCitationPrivateKey,
	importCitationPublicKey,
	signCitation,
	verifyCitationSignature,
} from "@bio-mcp/provenance-core";

export type {
	CitationJwk,
	CitationSigner,
	Jwks,
	SignatureVerdict,
} from "@bio-mcp/provenance-core";
