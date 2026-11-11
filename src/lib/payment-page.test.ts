import { afterEach, expect, it, vi } from "vitest";
import { paymentRoute } from "./payment-page";
import { hash } from "./release-http";
import { createOpenPaymentsApiFetch } from "./api-adapter";

const id = "800aed1b-20ed-4d19-b0c9-dcd10f197ffc";
const path = `/datasets/${id}/page`;
const selection = { program_year: 2025, payment_type: "ownership" };
const metadata = { identifier: id, title: "2025 Ownership Payment Data", issued: "2026-06-30", modified: "2026-06-30", distribution: [{ identifier: "fixture-distribution" }] };
const row = { program_year: "2025", payment_publication_date: "06/30/2026", record_id: "00123", physician_npi: "0123456789", change_type: "CHANGED", dispute_status_for_publication: "Yes", total_amount_invested_usdollars: "123.4500", native_future_field: "retain" };
function pages(before = metadata, native: unknown = { results: [row], count: 20 }, after = before): ReturnType<typeof vi.fn> {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(before)).mockResolvedValueOnce(Response.json(native)).mockResolvedValueOnce(Response.json(after));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
it("retains native values, identifiers and distinct publication/reporting dates", async () => {
  const fetcher = pages();
  expect(await paymentRoute(path, { ...selection, limit: 1 })).toMatchObject({ native: { results: [row], count: 20 }, metadata, _openpayments: { program_year: 2025, distribution_index: 0, rows_returned: 1, next_offset_candidate: 1, historical_snapshot: false, complete: false } });
  const url = fetcher.mock.calls[1][0] as URL;
  expect(url.pathname).toBe(`/api/1/datastore/query/${id}/0`);
  expect(url.searchParams.get("keys")).toBe("true");
  expect(url.searchParams.get("sorts[0][property]")).toBe("record_id");
  expect(url.searchParams.has("properties")).toBe(false);
});
it("guards a continuation with the preceding metadata hash", async () => {
  pages();
  const expected = await hash(metadata);
  expect(await paymentRoute(path, { ...selection, offset: 10, expected_metadata_sha256: expected })).toMatchObject({ _openpayments: { metadata_sha256: expected, request: { offset: 10 } } });
});
it("rejects metadata changed during a page", async () => {
  pages(metadata, { results: [row] }, { ...metadata, modified: "2027-01-15" });
  await expect(paymentRoute(path, selection)).rejects.toMatchObject({ status: 409 });
});
it("rejects a stale metadata hash before data I/O", async () => {
  const fetcher = pages();
  await expect(paymentRoute(path, { ...selection, expected_metadata_sha256: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([{ ...selection, program_year: 2026 }, { ...selection, payment_type: "general" }])("rejects dataset/selection mismatch", async params => {
  const fetcher = pages();
  await expect(paymentRoute(path, params)).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([{ ...row, program_year: "2024" }, { record_id: "1" }, ["2025"]])("rejects row-year or object-shape mismatch", async value => {
  pages(metadata, { results: [value] });
  await expect(paymentRoute(path, selection)).rejects.toMatchObject({ status: 502 });
});
it("requires an explicit choice for multiple distributions", async () => {
  const multiple = { ...metadata, distribution: [{ identifier: "one" }, { identifier: "two" }] };
  const fetcher = pages(multiple);
  await expect(paymentRoute(path, selection)).rejects.toMatchObject({ status: 400 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const second = pages(multiple);
  expect(await paymentRoute(path, { ...selection, distribution_index: 1 })).toMatchObject({ _openpayments: { distribution_index: 1 } });
  expect((second.mock.calls[1][0] as URL).pathname).toBe(`/api/1/datastore/query/${id}/1`);
});
it.each([
  { limit: 0 }, { limit: 501 }, { offset: -1 }, { offset: 1 }, { limit: [] },
  { properties: "record_id" }, { expected_metadata_sha256: "bad" },
  { conditions: [{ property: "name", value: "A", operator: "CONTAINS" }] },
  { conditions: [{ property: "name", value: ["A"], operator: "=" }] },
])("rejects malformed controls before I/O %j", async extra => {
  const fetcher = pages();
  await expect(paymentRoute(path, { ...selection, ...extra })).rejects.toMatchObject({ status: 400 });
  expect(fetcher).not.toHaveBeenCalled();
});
it("keeps empty filtered results explicit without asserting absence", async () => {
  pages(metadata, { results: [], count: 0 });
  expect(await paymentRoute(path, { ...selection, conditions: [{ property: "recipient_state", value: "TX", operator: "=" }] })).toMatchObject({ native: { results: [], count: 0 }, _openpayments: { complete: false, rows_returned: 0, next_offset_candidate: null } });
});
it("routes native metadata without requesting data", async () => {
  const fetcher = pages();
  expect(await paymentRoute(`/datasets/${id}/metadata`, {})).toMatchObject({ metadata, identity: selection });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("routes the new helper through the actual Code Mode adapter", async () => {
  pages();
  expect(await createOpenPaymentsApiFetch()({ method: "GET", path, params: selection })).toMatchObject({ status: 200, data: { native: { results: [row] } } });
});
it("rejects non-GET execution instead of silently ignoring a body", async () => {
  const fetcher = pages();
  await expect(createOpenPaymentsApiFetch()({ method: "POST", path, body: selection })).rejects.toMatchObject({ status: 405 });
  expect(fetcher).not.toHaveBeenCalled();
});
