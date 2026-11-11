import { afterEach, expect, it, vi } from "vitest";
import { releaseWorkflows } from "./releases";
import { openPaymentsCatalog } from "./catalog";
import { createOpenPaymentsApiFetch } from "../lib/api-adapter";

afterEach(() => vi.unstubAllGlobals());
it("executes the advertised discovery-to-page workflow with native publication evidence", async () => {
  const id = "800aed1b-20ed-4d19-b0c9-dcd10f197ffc";
  const metadata = { identifier: id, title: "2025 Research Payment Data", issued: "2026-06-30", distribution: [{}] };
  const row = { program_year: "2025", record_id: "123", payment_publication_date: "06/30/2026", clinicaltrials_gov_identifier: "NCT00000001", covered_recipient_npi: "0123456789" };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json([metadata])).mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(Response.json({ results: [row] })).mockResolvedValueOnce(Response.json(metadata));
  vi.stubGlobal("fetch", fetcher);
  const adapter = createOpenPaymentsApiFetch();
  const api = { get: async (path: string, params: Record<string, unknown>) => (await adapter({ method: "GET", path, params })).data };
  // Execute the checked-in public recipe against the real adapter and fixture transport.
  const run = new Function("api", `return (async () => { ${releaseWorkflows[0].code} })()`);
  expect(await run(api)).toMatchObject({ native: { results: [row] }, metadata, _openpayments: { program_year: 2025, payment_type: "research" } });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(openPaymentsCatalog.endpointCount).toBe(openPaymentsCatalog.endpoints.length);
});
it.each([{ candidates: [] }, { candidates: [{ dataset_id: "one" }, { dataset_id: "two" }] }])("recipe refuses absent or ambiguous candidates", async ({ candidates }) => {
  const api = { get: vi.fn().mockResolvedValue({ candidates }) };
  const run = new Function("api", `return (async () => { ${releaseWorkflows[0].code} })()`);
  await expect(run(api)).rejects.toThrow("Choose a dataset explicitly");
  expect(api.get).toHaveBeenCalledTimes(1);
});
