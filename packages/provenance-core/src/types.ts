import type {
	CANONICALIZATION_PROFILE,
	CITATION_VERSION,
	HASH_ALGORITHM,
} from "./constants";

export type QueryScope = "tool_arguments" | "tool_argument:code";

export type ResultScope =
	| "structured_content:data"
	| "structured_content:root_without_meta"
	| "staged:full_result";

export interface SourceDescriptor {
	id: string;
	name: string;
	url?: string;
	license?: string;
	version?: string;
}

export interface CitationSignature {
	alg: "Ed25519";
	key_id: string;
	signed_at: string;
	sig: string;
}

/** Version-one citation contract shared by issuers and every verifier. */
export interface Citation {
	citation_version: typeof CITATION_VERSION;
	hash_algorithm: typeof HASH_ALGORITHM;
	canonicalization_profile: typeof CANONICALIZATION_PROFILE;
	query_scope: QueryScope;
	result_scope: ResultScope;
	source: SourceDescriptor;
	server: string;
	tool: string;
	retrieved_at: string;
	query_hash: string;
	result_hash: string;
	issuer_git_sha: string;
	fleet_contract_version: string;
	record_count?: number;
	data_access_id?: string;
	negative_result?: boolean;
	verification?: string;
	signature?: CitationSignature;
	text: string;
}

export interface CitationJwk {
	kty?: string;
	crv?: string;
	x?: string;
	d?: string;
	kid?: string;
	use?: string;
	alg?: string;
	key_ops?: string[];
}

export interface Jwks {
	keys: CitationJwk[];
}

export interface TrustedCitationIssuer {
	require_signature?: boolean;
	keys: CitationJwk[];
}

export interface CitationTrustStore {
	version: 1;
	servers: Record<string, TrustedCitationIssuer>;
}

export type HashCheckStatus =
	| "verified"
	| "mismatch"
	| "unavailable"
	| "invalid";

export type SignatureCheckStatus =
	| "verified"
	| "unsigned"
	| "missing_required"
	| "unknown_key"
	| "bad_signature"
	| "malformed";

export interface CitationVerification {
	status: "verified" | "partial" | "failed";
	result: HashCheckStatus;
	query: HashCheckStatus;
	signature: SignatureCheckStatus;
	quarantined: boolean;
	reason?:
		| "staged_result_not_materialized"
		| "malformed_citation"
		| "hash_mismatch"
		| "signature_failure";
	actual_result_hash?: string;
	actual_query_hash?: string;
}

export interface CitationMetricCounters {
	citation_present: 0 | 1;
	verified: 0 | 1;
	staged_partial: 0 | 1;
	malformed: 0 | 1;
	mismatch: 0 | 1;
	signature_failure: 0 | 1;
}
