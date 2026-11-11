import { afterEach, expect, it, vi } from "vitest";
import { discoverPayments, paymentIdentity, paymentMetadata } from "./payment-releases";

const id = "800aed1b-20ed-4d19-b0c9-dcd10f197ffc";
// Representative native metadata fixture; actual provider JSON remains unvalidated.
const metadata = { identifier: id, title: "2025 Ownership Payment Data", issued: "2026-06-30", modified: "2026-06-30", temporal: "2025-01-01/2025-12-31", distribution: [{ identifier: "distribution-version", data: { downloadURL: "https://download.cms.gov/example.csv", format: "csv" } }] };
afterEach(() => vi.unstubAllGlobals());
it("discovers 2025 independently of 2026 publication and preserves distributions", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([metadata, { ...metadata, title: "2024 Ownership Payment Data" }, { title: "2025 Ownership Payment Totals", identifier: "summary" }])));
  expect(await discoverPayments({ program_year: 2025, payment_type: "ownership" })).toMatchObject({ candidates: [{ program_year: 2025, payment_type: "ownership", dataset_id: id, metadata }], catalog_entries_returned: 3 });
});
it("does not arbitrarily choose when more than one candidate matches", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([metadata, { ...metadata, identifier: "100aed1b-20ed-4d19-b0c9-dcd10f197ffc" }])));
  const result = await discoverPayments({ program_year: "2025" }) as { candidates: unknown[] };
  expect(result.candidates).toHaveLength(2);
});
it.each([
  ["2025 General Payment Data", { program_year: 2025, payment_type: "general" }],
  ["Research Payment Data – Detailed Dataset 2025 Reporting Year", { program_year: 2025, payment_type: "research" }],
  ["2025 general payment totals by state", null],
  ["Covered Recipient Profile Supplement", null],
])("classifies detailed-payment title %s", (title, expected) => {
  expect(paymentIdentity(title)).toEqual(expected);
});
it.each([{ program_year: "latest" }, { program_year: 2025, payment_type: "all" }, { program_year: 2025, url: "https://evil.test" }])("rejects unsupported selector %j", async params => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(discoverPayments(params)).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});
it("reads full metadata and requests generated reference identifiers", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(metadata)); vi.stubGlobal("fetch", fetcher);
  expect(await paymentMetadata(id, Date.now() + 1000)).toMatchObject({ metadata, metadata_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect((fetcher.mock.calls[0][0] as URL).searchParams.has("show-reference-ids")).toBe(true);
});
it.each([{ ...metadata, identifier: "100aed1b-20ed-4d19-b0c9-dcd10f197ffc" }, { ...metadata, distribution: undefined }, []])("rejects mismatched metadata", async value => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
  await expect(paymentMetadata(id, Date.now() + 1000)).rejects.toMatchObject({ status: 502 });
});
it("rejects unsupported catalog envelopes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ items: [metadata] })));
  await expect(discoverPayments({ program_year: 2025 })).rejects.toMatchObject({ status: 502 });
});
