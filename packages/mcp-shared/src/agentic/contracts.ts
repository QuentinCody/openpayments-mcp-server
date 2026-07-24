/**
 * Agentic-analysis contracts shared by servers, portals, and orchestrators.
 *
 * These types deliberately separate three questions that were previously
 * collapsed into a boolean success flag:
 *   1. Did execution complete without losing evidence?
 *   2. Is the evidence coverage sufficient for the requested consequence?
 *   3. Has the operation itself been validated to the required tier?
 */

export type ValidationTier =
	| "unvalidated"
	| "research"
	| "benchmarked"
	| "clinical";

export type AnalysisConsequence = "research" | "publication" | "clinical";

export type EvidenceDisposition =
	| "complete"
	| "partial"
	| "insufficient_evidence"
	| "invalid_context"
	| "external_access_unavailable";

export type ContextDimension =
	| "assembly"
	| "species"
	| "sequencing_platform"
	| "tissue"
	| "population"
	| "ancestry";

export interface ValidationEvidence {
	kind: "unit" | "perturbation" | "benchmark" | "multi_site" | "regulatory";
	reference: string;
	verified_at?: string;
}

export interface ValidationRecord {
	tier: ValidationTier;
	intended_uses: AnalysisConsequence[];
	prohibited_uses?: AnalysisConsequence[];
	required_context?: ContextDimension[];
	validated_context?: Partial<Record<ContextDimension, string[]>>;
	data_versions?: Record<string, string>;
	known_limitations?: string[];
	validation_evidence?: ValidationEvidence[];
	equity?: {
		validation_populations: string[];
		metrics_stratified_by: string[];
		non_european_validation: boolean;
	};
	minimum_sources?: number;
}

export interface ValidationDecision {
	allowed: boolean;
	required_tier: ValidationTier;
	actual_tier: ValidationTier;
	missing_context: ContextDimension[];
	issues: string[];
}

const TIER_RANK: Record<ValidationTier, number> = {
	unvalidated: 0,
	research: 1,
	benchmarked: 2,
	clinical: 3,
};

export function requiredTier(
	consequence: AnalysisConsequence,
): ValidationTier {
	if (consequence === "clinical") return "clinical";
	if (consequence === "publication") return "benchmarked";
	return "research";
}

/** Fail-closed validation gate. Missing context is never guessed. */
export function evaluateValidation(
	record: ValidationRecord,
	consequence: AnalysisConsequence,
	context: Partial<Record<ContextDimension, string>> = {},
): ValidationDecision {
	const required = requiredTier(consequence);
	const missing = (record.required_context ?? []).filter(
		(key) => !context[key]?.trim(),
	);
	const issues: string[] = [];
	if (TIER_RANK[record.tier] < TIER_RANK[required]) {
		issues.push(
			`${record.tier} validation does not meet the ${required} requirement for ${consequence} use`,
		);
	}
	if (record.prohibited_uses?.includes(consequence)) {
		issues.push(`${consequence} use is explicitly prohibited`);
	}
	if (!record.intended_uses.includes(consequence)) {
		issues.push(`${consequence} use is outside the declared intended uses`);
	}
	if (missing.length > 0) {
		issues.push(`required context missing: ${missing.join(", ")}`);
	}
	for (const [dimension, allowed] of Object.entries(
		record.validated_context ?? {},
	) as Array<[ContextDimension, string[]]>) {
		const supplied = context[dimension];
		if (supplied && allowed.length > 0 && !allowed.includes(supplied)) {
			issues.push(
				`${dimension}=${supplied} is outside the validated context (${allowed.join(", ")})`,
			);
		}
	}
	return {
		allowed: issues.length === 0,
		required_tier: required,
		actual_tier: record.tier,
		missing_context: missing,
		issues,
	};
}

export interface ReplayToolCall {
	sequence: number;
	server: string;
	tool: string;
	arguments: Record<string, unknown>;
	query_hash: string;
	result_hash?: string;
	started_at: string;
	completed_at?: string;
	disposition: EvidenceDisposition;
	error?: { code: string; message: string };
}

export interface HypothesisRecord {
	id: string;
	statement: string;
	preregistered: boolean;
	analysis_variants: string[];
}

export interface AgenticRunManifest {
	schema_version: "1.0";
	run_id: string;
	created_at: string;
	consequence: AnalysisConsequence;
	disposition: EvidenceDisposition;
	model?: string;
	prompt_hash?: string;
	ruleset_hash?: string;
	tool_calls: ReplayToolCall[];
	validation: ValidationDecision[];
	hypotheses: HypothesisRecord[];
	requested_sources: string[];
	completed_sources: string[];
	external_access_unavailable: string[];
}

/** Access failures remain visible but are not misreported as implementation defects. */
export function classifyExternalAccessFailure(message: string): boolean {
	return /\b(401|403|unauthori[sz]ed|forbidden|api[ _-]?key|oauth|credentials?|authentication|access denied|subscription required)\b/i.test(
		message,
	);
}

