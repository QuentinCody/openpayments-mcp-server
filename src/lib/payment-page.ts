import { allowed, datasetId, discoverPayments, paymentIdentity, paymentMetadata, record, selector, type PaymentMetadata } from "./payment-releases";
import { fail, hash, releaseRead } from "./release-http";

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max) fail(`Invalid ${name}`);
  return Number(value);
}
function expectedHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("Invalid expected_metadata_sha256");
  return value;
}
function conditions(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail("conditions must contain at most 20 simple DKAN conditions");
  for (const item of value) {
    if (!record(item) || Object.keys(item).some(key => !["property", "value", "operator"].includes(key))) fail("Unsupported condition shape");
    if (typeof item.property !== "string" || !/^[a-z][a-z0-9_]{0,199}$/.test(item.property)) fail("Invalid condition property");
    if (typeof item.operator !== "string" || !["=", "<>", "<", ">", "<=", ">=", "LIKE"].includes(item.operator)) fail("Unsupported condition operator");
    if (typeof item.value !== "string" || item.value.length > 2000) fail("Condition values must be bounded native strings");
  }
  return value;
}
function queryParams(params: Record<string, unknown>): Record<string, unknown> & { limit: number; offset: number } {
  const filters = conditions(params.conditions);
  const query = { limit: integer(params.limit, 50, 1, 500, "limit"), offset: integer(params.offset, 0, 0, 100000000, "offset"),
    sorts: [{ property: "record_id", order: "asc" }], keys: true, schema: false, count: true };
  return filters.length ? { ...query, conditions: filters } : query;
}
function distributionIndex(metadata: PaymentMetadata, value: unknown): number {
  if (!metadata.distribution.length) fail("Dataset has no distributions", 502);
  if (value === undefined && metadata.distribution.length !== 1) fail("Choose distribution_index explicitly from metadata when multiple distributions exist");
  return integer(value, 0, 0, metadata.distribution.length - 1, "distribution_index");
}
function checkYear(rows: unknown[], year: number, limit: number): void {
  if (rows.length > limit) fail("Upstream returned more rows than requested", 502);
  for (const row of rows) {
    if (!record(row) || String(row.program_year) !== String(year)) fail("Payment row program_year missing or inconsistent with selection", 502);
  }
}

async function page(id: string, params: Record<string, unknown>): Promise<unknown> {
  allowed(params, ["program_year", "payment_type", "distribution_index", "expected_metadata_sha256", "limit", "offset", "conditions"]);
  const wanted = selector(params, true);
  const query = queryParams(params);
  const expected = expectedHash(params.expected_metadata_sha256);
  if (query.offset > 0 && !expected) fail("Continuation requires expected_metadata_sha256 from the preceding page");
  const deadline = Date.now() + 45_000;
  const before = await paymentMetadata(id, deadline);
  const identity = paymentIdentity(before.metadata.title);
  if (identity?.program_year !== wanted.program_year || identity?.payment_type !== wanted.payment_type) fail("Dataset does not match requested program year and payment type", 409);
  if (expected && before.metadata_sha256 !== expected) fail("Open Payments metadata changed from requested version", 409);
  const index = distributionIndex(before.metadata, params.distribution_index);
  const source = await releaseRead(`/datastore/query/${id}/${index}`, query, deadline);
  if (!record(source.data) || !Array.isArray(source.data.results)) fail("Unrecognized DKAN result envelope", 502);
  checkYear(source.data.results, wanted.program_year, query.limit);
  const after = await paymentMetadata(id, deadline);
  if (before.metadata_sha256 !== after.metadata_sha256) fail("Dataset metadata changed during query; discard and retry", 409);
  return { native: source.data, metadata: before.metadata, _openpayments: {
    ...wanted, dataset_id: id, distribution_index: index, metadata_sha256: before.metadata_sha256, response_sha256: await hash(source.data),
    source_url: source.source_url, retrieved_at: new Date().toISOString(), request: query,
    rows_returned: source.data.results.length,
    next_offset_candidate: source.data.results.length === query.limit ? query.offset + source.data.results.length : null,
    complete: false, historical_snapshot: false,
    note: "Metadata stable across this read is not an atomic data snapshot. Retain hash on continuation. An empty filtered page is not proof of no payments. Preserve record_id, program_year, payment_publication_date, change_type and dispute status; publication/revision dates are not reporting years. Join providers/companies by native identifiers, not names alone.",
  } };
}

export async function paymentRoute(path: string, params: Record<string, unknown>): Promise<unknown> {
  if (path === "/datasets/discover") return discoverPayments(params);
  const match = path.match(/^\/datasets\/([^/]+)\/(metadata|page)$/);
  if (!match) fail("Unknown Open Payments release route", 404);
  const id = datasetId(match[1]);
  if (match[2] === "page") return page(id, params);
  allowed(params, []);
  const source = await paymentMetadata(id, Date.now() + 15_000);
  return { ...source, identity: paymentIdentity(source.metadata.title), retrieved_at: new Date().toISOString(), historical_snapshot: false };
}
