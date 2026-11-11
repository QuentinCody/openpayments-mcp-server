import { fail, hash, releaseRead } from "./release-http";

export const METADATA_PATH = "/metastore/schemas/dataset/items";
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export type PaymentType = "general" | "research" | "ownership";
export interface PaymentIdentity { program_year: number; payment_type: PaymentType }
export interface PaymentMetadata extends Record<string, unknown> { identifier: string; title: string; distribution: unknown[] }

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function datasetId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail("dataset_id must be a UUID");
  return value;
}
export function allowed(params: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(params).some(key => !keys.includes(key))) fail("Unsupported release parameter");
}
export function selector(params: Record<string, unknown>, requireType = false): { program_year: number; payment_type?: PaymentType } {
  const year = params.program_year;
  if ((typeof year !== "number" && typeof year !== "string") || !/^20\d{2}$/.test(String(year))) fail("program_year must be a four-digit reporting year");
  const type = params.payment_type;
  if (type === undefined && !requireType) return { program_year: Number(year) };
  if (type !== "general" && type !== "research" && type !== "ownership") fail("payment_type must be general, research, or ownership");
  return { program_year: Number(year), payment_type: type };
}

/** Only detailed-payment titles qualify; aggregate tables must not masquerade as records. */
export function paymentIdentity(title: string): PaymentIdentity | null {
  const simple = title.trim().match(/^(20\d{2})\s+(General|Research|Ownership) Payment Data$/i);
  const detailed = title.trim().match(/^(General|Research|Ownership) Payment Data\s*[-–—]\s*Detailed Dataset (20\d{2}) Reporting Year$/i);
  if (!simple && !detailed) return null;
  // SAFETY: both patterns restrict this capture to the three PaymentType values.
  const payment_type = (simple?.[2] ?? detailed?.[1] ?? "").toLowerCase() as PaymentType;
  return { program_year: Number(simple?.[1] ?? detailed?.[2]), payment_type };
}

function qualified(value: unknown): PaymentMetadata {
  if (!record(value) || typeof value.identifier !== "string" || !UUID.test(value.identifier) || typeof value.title !== "string" || !Array.isArray(value.distribution)) fail("Unrecognized Open Payments metadata", 502);
  // SAFETY: required metadata fields checked above; all other native fields retained.
  return value as PaymentMetadata;
}

export async function paymentMetadata(id: string, deadline: number): Promise<{ metadata: PaymentMetadata; metadata_sha256: string; source_url: string }> {
  const source = await releaseRead(`${METADATA_PATH}/${datasetId(id)}`, { "show-reference-ids": "" }, deadline);
  const metadata = qualified(source.data);
  if (metadata.identifier !== id) fail("Metadata identifier does not match requested dataset", 502);
  return { metadata, metadata_sha256: await hash(metadata), source_url: source.source_url };
}

export async function discoverPayments(params: Record<string, unknown>): Promise<unknown> {
  allowed(params, ["program_year", "payment_type"]);
  const wanted = selector(params);
  const source = await releaseRead(METADATA_PATH, { "show-reference-ids": "" }, Date.now() + 20_000, 16 * 1024 * 1024);
  if (!Array.isArray(source.data)) fail("Unrecognized Open Payments dataset catalog", 502);
  const candidates = [];
  for (const entry of source.data) {
    if (!record(entry) || typeof entry.title !== "string") fail("Malformed dataset catalog entry", 502);
    const identity = paymentIdentity(entry.title);
    if (!identity || identity.program_year !== wanted.program_year || (wanted.payment_type && identity.payment_type !== wanted.payment_type)) continue;
    const metadata = qualified(entry);
    candidates.push({ ...identity, dataset_id: metadata.identifier, metadata_sha256: await hash(metadata), metadata });
  }
  return { candidates, catalog_sha256: await hash(source.data), source_url: source.source_url, retrieved_at: new Date().toISOString(),
    requested: wanted, catalog_entries_returned: source.data.length,
    note: "Candidates from the returned metadata catalog; no automatic latest selection. Program year is derived from the detailed-payment title. Preserve issued, modified, temporal, distribution and row publication/change/dispute fields separately. No match is not proof that a program year has no payments." };
}
