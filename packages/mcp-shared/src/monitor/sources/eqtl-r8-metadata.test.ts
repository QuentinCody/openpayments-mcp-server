import { expect, it } from "vitest";
import { R8_METADATA_URL } from "../../adapters/eqtl/beta-metadata";
import { sha256Hex } from "../../provenance/provenance";
import { runOnce } from "../run-once";
import { eqtlR8Metadata } from "./eqtl-r8-metadata";

const metadata = () => "study_id\tdataset_id\tstudy_label\tsample_group\ttissue_id\ttissue_label\tcondition_label\tsample_size\tquant_method\tpmid\tstudy_type\textension\n" +
  "QTS000015\tQTD000116\tGTEx_v10\tadipose_subcutaneous\tUBERON_0001013\tadipose\tnaive\t711\tge\t32913098\tbulk\tα😀\n";
async function envelope(raw = metadata()) {
  return { success: true, data: { release: "r8_beta", status: "pre-release", assembly: "GRCh38", metadata_url: R8_METADATA_URL,
    metadata_sha256: await sha256Hex(raw), raw_metadata_tsv: raw, columns: raw.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].split("\t"),
    total_datasets: raw.trimEnd().split(/\r?\n/).length - 1, http_status: 200, coverage_complete: true, retrieved_at: "2026-10-06T00:00:00Z" } };
}
const tick = async (raw: string, prior?: Awaited<ReturnType<typeof runOnce>>) => runOnce({ source: eqtlR8Metadata, input: {},
  run: async () => envelope(raw), priorRowSets: prior?.rowSets, priorContentHash: prior?.contentHash });

it("compares native dataset metadata and file pins separately, preserving unknown columns and strings", async () => {
  const first = await tick(metadata());
  expect(first.query).toEqual({ server: "eqtl", tool: "eqtl_metadata_snapshot", params: { release: "r8_beta" } });
  expect(first.rowSets[1].rows).toMatchObject([{ release: "r8_beta", dataset_id: "QTD000116", metadata: { sample_size: "711", extension: "α😀", study_label: "GTEx_v10" } }]);
  const after = await tick(metadata().replace("711", "712"), first);
  expect(after.changes).toHaveLength(2);
  expect(after.changes.find(c => c.table === "datasets")).toMatchObject({ key: "r8_beta|QTD000116", kind: "changed", materiality: "info",
    before: { metadata: { sample_size: "711" } }, after: { metadata: { sample_size: "712" } } });
});

it("reports added/removed datasets without joining reused IDs across releases", async () => {
  const first = await tick(metadata());
  const after = await tick(metadata().replace("QTD000116", "QTD000117"), first);
  expect(after.changes.filter(c => c.table === "datasets").map(c => [c.kind, c.key]).sort()).toEqual([["added", "r8_beta|QTD000117"], ["removed", "r8_beta|QTD000116"]]);
  const wrong = await envelope(); wrong.data.release = "r7";
  await expect(eqtlR8Metadata.prepareResult!(wrong)).rejects.toThrow("mismatched");
});

it("detects changed file bytes even if dataset values do not change", async () => {
  const first = await tick(metadata());
  const after = await tick("\uFEFF" + metadata().replace(/\n/g, "\r\n"), first);
  expect(after.changes).toHaveLength(1); expect(after.changes[0]).toMatchObject({ table: "metadata_file", kind: "changed" });
});

it("does not alert on cache/citation/retrieval churn", async () => {
  const first = await tick(metadata()); const current = await envelope(); current.data.retrieved_at = "2026-10-06T01:00:00Z";
  const next = await runOnce({ source: eqtlR8Metadata, input: {}, run: async () => ({ ...current, _meta: { citation: "new" } }), priorRowSets: first.rowSets, priorContentHash: first.contentHash });
  expect(next.unchanged).toBe(true); expect(next.changes).toEqual([]);
});

it.each([
  { metadata_sha256: "0".repeat(64) }, { metadata_url: "https://example.org" }, { assembly: "GRCh37" }, { status: "released" },
  { http_status: 206 }, { coverage_complete: false }, { total_datasets: 2 }, { columns: [] }, { retrieved_at: "invalid" }, { raw_metadata_tsv: undefined },
])("rejects altered, incomplete or unknown source evidence %#", async change => {
  const result = await envelope(); Object.assign(result.data, change);
  await expect(eqtlR8Metadata.prepareResult!(result)).rejects.toThrow();
});

it.each([
  () => metadata().split("\n")[0] + "\n",
  () => metadata() + metadata().split("\n")[1] + "\n",
  () => metadata().replace("QTD000116", "not-an-ID"),
  () => metadata().replace("711", "unknown"),
  () => metadata().replace("α😀", "extra\tcolumn"),
  () => metadata().replace("α😀", "x".repeat(65536)),
  () => metadata().replace("α😀", "x".repeat(512 * 1024)),
])("rejects a rehashed malformed or oversized complete-file claim %#", async raw => {
  await expect(tick(raw())).rejects.toThrow();
});
