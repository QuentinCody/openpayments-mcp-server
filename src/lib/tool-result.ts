import { buildCitation, type Completeness, mergeCompleteness } from "@bio-mcp/shared";
import { shouldStage, stageToDoAndRespond } from "@bio-mcp/shared/staging/utils";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
type Result = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean; [key: string]: unknown };
export type OpenpayDataEnv = { OPENPAYMENTS_DATA_DO?: unknown };
export const OPENPAYMENTS_SOURCE = { id: "openpay", name: "CMS Open Payments", url: "https://openpaymentsdata.cms.gov" };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
// The MCP SDK adds resultType and serverInfo after this callback returns.
const TRANSPORT_METADATA_RESERVE = 1024;

async function cite(structured: Record<string, unknown>, toolName: string, query: unknown) {
  const meta = record(structured._meta) ? structured._meta : {};
  if (record(meta.citation)) return structured;
  const { _meta: _metadata, ...root } = structured;
  const citation = await buildCitation({ source: OPENPAYMENTS_SOURCE, server: "openpay", tool: toolName.replace(/^mcp_/, ""), query,
    queryScope: "tool_arguments", result: root, resultScope: "structured_content:root_without_meta", retrievedAt: new Date().toISOString() });
  return { ...structured, _meta: { ...meta, citation } };
}

/** Cite every response and stage the complete composed MCP envelope above 30KiB. */
export async function openpayResponse(work: () => Promise<Result>, env: OpenpayDataEnv, toolName: string, extra: unknown, query: unknown = {}): Promise<Result> {
  try {
    const original: Result = await work().catch(error => {
      return requestFailure(error);
    });
    let structured = original.structuredContent ?? { success: original.isError !== true };
    const meta = record(structured._meta) ? structured._meta : {};
    const existing: Completeness | undefined = record(meta.completeness) && typeof meta.completeness.complete === "boolean"
      ? { ...meta.completeness, complete: meta.completeness.complete } : undefined;
    const completeness = mergeCompleteness(existing, toolName.endsWith("openpay_execute") ? {
      complete: false, truncation: { reason: "unknown", detail: "A bounded Open Payments catalog/data observation does not establish complete dataset coverage, an atomic snapshot, complete payments, wrongdoing or provider quality.",
        remedy: "Retain native rows, metadata/distributions, request and hashes. Use metadata-guarded continuation; distinguish publication dates from reporting periods, general/research/ownership records from aggregates, blanks from zero, and recipient identifiers from investigator or company identifiers. Preserve disputes, change types, publication dates, all numbered investigator/product fields and native values." },
    } : undefined);
    if (completeness) structured = { ...structured, _meta: { ...meta, completeness },
      ...(record(structured._staging) ? { _staging: { ...structured._staging, completeness } } : {}) };
    const apiError = record(structured.data) && structured.data.__api_error === true;
    const failed = original.isError === true || structured.success === false || apiError || Boolean(structured.program_error) || structured.disposition === "partial";
    const result = { ...original, structuredContent: await cite(failed ? { ...structured, success: false } : structured, toolName, query), ...(failed ? { isError: true } : {}) };
    if (!shouldStage(bytes(result) + TRANSPORT_METADATA_RESERVE)) return result;
    return await stageResponse(env, result, toolName, extra, query, completeness, failed);
  } catch {
    const message = "Open Payments response could not be returned.";
    const data = { success: false, error: { code: "RESPONSE_ERROR", message } };
    const citation = await buildCitation({ source: OPENPAYMENTS_SOURCE, server: "openpay", tool: toolName.replace(/^mcp_/, ""),
      query, queryScope: "tool_arguments", retrievedAt: new Date().toISOString(), result: data, resultScope: "structured_content:root_without_meta" });
    return { content: [{ type: "text", text: message }], structuredContent: { ...data, _meta: { citation } }, isError: true };
  }
}

function requestFailure(error: unknown) : Result {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  const message = status && error instanceof Error ? error.message.slice(0, 500) : "Open Payments response could not be returned.";
  return {
    content: [{ type: "text" as const, text: message }], isError: true,
    structuredContent: {
      success: false, error: { code: status ? "API_ERROR" : "RESPONSE_ERROR", message, status },
      ...(error && typeof error === "object" && "data" in error ? { data: error.data } : {})
    }
  };
}

async function stageResponse(env: OpenpayDataEnv, result: Result, toolName: string, extra: unknown, query: unknown, completeness: Completeness | undefined, failed: unknown) : Promise<Result> {
  if (!env.OPENPAYMENTS_DATA_DO) throw new Error("Missing staging storage");
  const staged = await stageToDoAndRespond(result, env.OPENPAYMENTS_DATA_DO as Parameters<typeof stageToDoAndRespond>[1], "openpay", undefined,
    { toolName, serverName: "openpay" }, "openpay", extra as Parameters<typeof stageToDoAndRespond>[6]);
  const citation = await buildCitation({
    source: OPENPAYMENTS_SOURCE, server: "openpay", tool: toolName.replace(/^mcp_/, ""),
    query, queryScope: "tool_arguments", retrievedAt: new Date().toISOString(), result, resultScope: "staged:full_result", dataAccessId: staged.dataAccessId
  });
  const combined = mergeCompleteness(completeness, staged._staging.completeness);
  const structuredContent = {
    success: !failed, staged: true, data: undefined, data_access_id: staged.dataAccessId,
    _staging: { ...staged._staging, ...(combined ? { completeness: combined } : {}) }, _meta: { citation, ...(combined ? { completeness: combined } : {}) }
  };
  if (bytes(structuredContent) > 100000) throw new Error("Staging metadata exceeds transport limit");
  return { content: [{ type: "text", text: "Response staged. Use openpay_query_data; payloads retains the complete original response." }], structuredContent, ...(failed ? { isError: true } : {}) };
}
