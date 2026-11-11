import { afterEach, expect, it, vi } from "vitest";
import { McpServer } from "@bio-mcp/shared/mcp";
import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import { OpenPaymentsDataDO } from "../do";
import { registerCodeMode } from "./code-mode";
import { registerQueryData } from "./query-data";
import { registerGetSchema } from "./get-schema";
import { openPaymentsCatalog } from "../spec/catalog";
import { createOpenPaymentsApiFetch } from "../lib/api-adapter";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("registers both aliases for every tool and returns both fields on tested success/error paths", async () => {
  const server = new McpServer({ name: "fixture", version: "1" });
  // SAFETY: invalid execution never invokes loader or DO.
  registerCodeMode(server, { CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1]);
  registerQueryData(server, {}); registerGetSchema(server, {});
  // SAFETY: inspect actual SDK callbacks solely for the registration contract.
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools;
  expect(Object.keys(tools)).toHaveLength(8);
  for (const prefix of ["", "mcp_"]) {
    expect(await tools[prefix + "openpay_search"].handler({ query: "program year", max_results: 5 }, {})).toMatchObject({ content: expect.any(Array), structuredContent: { success: true } });
    for (const [name, args] of [["execute", { code: "" }], ["query_data", { data_access_id: "fixture", sql: "SELECT 1" }], ["get_schema", { data_access_id: "fixture" }]] as const) {
      expect(await tools[prefix + "openpay_" + name].handler(args, {})).toMatchObject({ content: expect.any(Array), structuredContent: expect.any(Object), isError: true });
    }
  }
});

it("preserves native wide rows and publication metadata through the actual DO preprocess boundary", async () => {
  const id = "800aed1b-20ed-4d19-b0c9-dcd10f197ffc";
  const metadata = { identifier: id, title: "2025 Research Payment Data", issued: "2026-06-30", distribution: [{}] };
  const row = { ...Object.fromEntries(Array.from({ length: 180 }, (_, i) => [`native_${i}`, "value"])), program_year: "2025", record_id: "0001", payment_publication_date: "06/30/2026", principal_investigator_2_npi: "0123456789", principal_investigator_2_name: "", notes: "α".repeat(20000) };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(Response.json({ results: [row] })).mockResolvedValueOnce(Response.json(metadata)));
  const stored: unknown[] = [];
  vi.spyOn(RestStagingDO.prototype, "fetch").mockImplementation(async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      // SAFETY: payload comes from the real server preprocessing hook under test.
      const payload = await request.json() as { data: unknown }; stored.push(payload.data);
      return Response.json({ success: true, tables_created: ["payloads"], total_rows: 1 });
    }
    return Response.json({ success: true, schema: { tables: { payloads: { columns: [{ name: "root_json" }] } } } });
  });
  // SAFETY: parent fetch is mocked, so the real preprocessing hook needs no DO runtime state.
  const target = Object.create(OpenPaymentsDataDO.prototype) as OpenPaymentsDataDO;
  // SAFETY: fixture implements both namespace methods used by staging.
  const namespace = { idFromName: (name: string) => name, get: () => target } as unknown as DurableObjectNamespace;
  const proxy = createApiProxyTool({ apiFetch: createOpenPaymentsApiFetch(), catalog: openPaymentsCatalog, doNamespace: namespace, stagingPrefix: "openpay", maxInlineBytes: 30 * 1024 });
  const result = await proxy.handler({ method: "GET", path: `/datasets/${id}/page`, params: { program_year: 2025, payment_type: "research" } }, { sql: () => [] });
  expect(result).toMatchObject({ __staged: true, data_access_id: expect.any(String) });
  expect(stored.map(value => typeof value === "string" ? JSON.parse(value) : value)).toEqual(expect.arrayContaining([expect.objectContaining({ native: { results: [row] }, metadata })]));
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(100000);
});
