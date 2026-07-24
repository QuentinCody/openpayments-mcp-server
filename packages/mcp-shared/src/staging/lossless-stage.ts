/** Lossless pre-materialization write for per-server staging Durable Objects. */
import { serializedBytes } from "../agentic/lossless";
import { canonicalJson, sha256Hex } from "../provenance/provenance";
import { parseJsonResponse } from "./do-response";
import { DO_FETCH_ORIGIN } from "./workspace-staging";

interface DurableObjectStub {
	fetch(req: Request): Promise<Response>;
}

export interface LosslessStageProvenance {
	toolName?: string;
	serverName?: string;
	args?: Record<string, unknown>;
	apiUrl?: string;
}

export interface PreservedPayload {
	evidenceTable: "payloads";
	payloadHash: string;
	payloadBytes: number;
}

/**
 * Persist canonical source bytes as a scalar payload before inferred-table
 * staging. Scalar input forces RestStagingDO's chunk-aware raw-payload path,
 * so later inference failures or skipped rows cannot erase the source data.
 */
export async function preservePayloadInDo(
	data: unknown,
	doInstance: DurableObjectStub,
	provenance?: LosslessStageProvenance,
): Promise<PreservedPayload> {
	const canonical = canonicalJson(data);
	const response = await doInstance.fetch(
		new Request(`${DO_FETCH_ORIGIN}/process`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				data: canonical,
				context: {
					...provenance,
					toolName: `${provenance?.toolName ?? "unknown"}__lossless_evidence`,
				},
			}),
		}),
	);
	const result = await parseJsonResponse<{ success?: boolean; error?: string }>(
		response,
		{ success: false, error: "Empty response from evidence store" },
	);
	if (!result.success) {
		throw new Error(
			`Failed to preserve complete source payload: ${result.error ?? "unknown error"}`,
		);
	}
	return {
		evidenceTable: "payloads",
		payloadHash: `sha256:${await sha256Hex(canonical)}`,
		payloadBytes: serializedBytes(data),
	};
}

