import { expect, it } from "vitest";
import { openpayResponse } from "./tool-result";

it("stages the composed envelope and preserves Unicode plus the failure flag", async () => {
  const original = { content: [{ type: "text" as const, text: "α😀".repeat(6000) }], structuredContent: { success: false, data: { notes: "native Open Payments detail" } }, isError: true };
  const stored: unknown[] = [];
  const env = { OPENPAYMENTS_DATA_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") stored.push((await request.json() as { data: unknown }).data);
    return Response.json({ success: true, tables_created: ["payloads"], total_rows: 1, input_rows: 1, schema: { tables: {} } });
  } }) } };
  const result = await openpayResponse(async () => original, env, "mcp_openpay_execute", {}, { code: "fixture" });
  expect(result).toMatchObject({ isError: true, structuredContent: { success: false, staged: true, _staging: { evidence_table: "payloads" }, _meta: { citation: { result_scope: "staged:full_result" } } } });
  expect(stored.map(value => typeof value === "string" ? JSON.parse(value) : value)).toEqual(expect.arrayContaining([expect.objectContaining({ content: original.content, isError: true })]));
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30720);
});

it("returns a bounded cited error when the required storage is unavailable", async () => {
  const result = await openpayResponse(async () => ({ content: [{ type: "text", text: "α".repeat(20000) }], structuredContent: { success: true } }), {}, "openpay_execute", {});
  expect(result).toMatchObject({ content: expect.any(Array), isError: true, structuredContent: { success: false, error: { code: "RESPONSE_ERROR" }, _meta: { citation: { result_hash: expect.any(String) } } } });
});

it("leaves room for SDK-added transport metadata near the staging boundary", async () => {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const raw = { content: [{ type: "text" as const, text: "Result" }], structuredContent: { data: "" } };
  const baseline = await openpayResponse(async () => raw, {}, "openpay_query_data", {});
  const original = { ...raw, structuredContent: { data: "x".repeat(30720 - size(baseline) - 512) } };
  const env = { OPENPAYMENTS_DATA_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async () =>
    Response.json({ success: true, tables_created: ["payloads"], total_rows: 1, input_rows: 1, schema: { tables: {} } }),
  }) } };
  const result = await openpayResponse(async () => original, env, "openpay_query_data", {});
  expect(result.structuredContent).toMatchObject({ staged: true, _meta: { citation: { result_scope: "staged:full_result" } } });
  const wire = { ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": { name: "cms-provider", version: "0.1.0" } } };
  expect(size(wire)).toBeLessThan(30720);
});
