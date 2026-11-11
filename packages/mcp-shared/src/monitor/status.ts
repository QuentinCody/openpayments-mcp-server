export type FailureKind = "credential_failure" | "transport_failure" | "tool_failure" | "check_failure";

export class MonitorCallError extends Error {
  constructor(public readonly kind: FailureKind, public readonly boundary: "mcp_transport" | "mcp_tool", public readonly status: number | null, message: string) {
    super(message);
  }
}

export interface Attempt {
  checked_at: string;
  outcome: "success" | "failure";
  failure_kind: FailureKind | null;
  boundary: string | null;
  upstream_status: number | null;
}

/** Persist only explicit classification, never provider error text or credentials. */
export function failedAttempt(error: unknown, checkedAt: string): Attempt {
  if (error instanceof MonitorCallError) return { checked_at: checkedAt, outcome: "failure", failure_kind: error.kind, boundary: error.boundary, upstream_status: error.status };
  return { checked_at: checkedAt, outcome: "failure", failure_kind: "check_failure", boundary: null, upstream_status: null };
}

export function monitoringStatus(lastSuccess: string | null, cadenceMs: number, latest: Attempt | null, now = Date.now()): {
  last_success_at: string | null; last_attempt: Attempt | null; freshness: string; stale_after_ms: number; freshness_basis: string; provider_data_age: string;
} {
  const age = lastSuccess === null ? null : now - Date.parse(lastSuccess);
  const freshness = age === null ? "never_succeeded" : !Number.isFinite(age) || age < 0 ? "unknown" : age > cadenceMs * 2 ? "stale" : "fresh";
  return { last_success_at: lastSuccess, last_attempt: latest, freshness, stale_after_ms: cadenceMs * 2,
    freshness_basis: "last_successful_check", provider_data_age: "unknown" };
}
