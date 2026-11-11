import { parseBetaMetadata, R8_METADATA_URL } from "../../adapters/eqtl/beta-metadata";
import { sha256Hex } from "../../provenance/provenance";
import { object, recoverStagedPayload } from "../staged-payload";
import type { SourceModule } from "../types";

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** No rows are inferred from counts or previews: reparse the complete hashed TSV. */
async function prepareResult(result: unknown, run?: Parameters<typeof recoverStagedPayload>[3]) {
  const payload = object(await recoverStagedPayload(result, "eqtl", "eqtl_query_data", run));
  const raw = payload?.raw_metadata_tsv;
  if (!payload || payload.release !== "r8_beta" || payload.status !== "pre-release" || payload.assembly !== "GRCh38" ||
    payload.metadata_url !== R8_METADATA_URL || payload.http_status !== 200 || payload.coverage_complete !== true ||
    typeof payload.retrieved_at !== "string" || !Number.isFinite(Date.parse(payload.retrieved_at)) ||
    typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 512 * 1024 || payload.metadata_sha256 !== await sha256Hex(raw)) {
    throw new Error("monitor: incomplete or mismatched r8 metadata snapshot; retaining prior snapshot");
  }
  const columns = raw.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].split("\t");
  if (columns.some(column => !column) || JSON.stringify(columns) !== JSON.stringify(payload.columns)) throw new Error("monitor: r8 metadata columns mismatch");
  const datasets = parseBetaMetadata(raw);
  if (datasets.length > 5000 || payload.total_datasets !== datasets.length) throw new Error("monitor: r8 metadata count mismatch or snapshot limit exceeded");
  const rows = datasets.map(dataset => ({ release: "r8_beta", dataset_id: dataset.dataset_id, metadata: dataset.metadata }));
  if (rows.some(row => size(row) > 64 * 1024)) throw new Error("monitor: r8 metadata row exceeds 64 KiB");
  const prepared = {
    files: [{ release: "r8_beta", file: { metadata_sha256: payload.metadata_sha256, columns } }],
    datasets: rows,
    evidence: { ...payload, citation: object(object(result)?._meta)?.citation },
  };
  if (size(prepared) > 900_000) throw new Error("monitor: r8 metadata exceeds snapshot budget");
  return prepared;
}

export const eqtlR8Metadata: SourceModule = {
  id: "eqtl-r8-metadata",
  label: "eQTL Catalogue r8 beta — complete metadata file and dataset definitions",
  profile: { tables: [
    { table: "metadata_file", path: "files", keyFields: ["release"], valueFields: ["file"] },
    { table: "datasets", path: "datasets", keyFields: ["release", "dataset_id"], valueFields: ["metadata"] },
  ] },
  buildQuery: () => ({ server: "eqtl", tool: "eqtl_metadata_snapshot", params: { release: "r8_beta" } }),
  prepareResult,
  classify: change => ({ materiality: "info", label: change.table === "metadata_file"
    ? "eQTL r8 beta metadata file changed; refresh checksum pins (not an association-file or final-release assertion)"
    : `eQTL r8 beta dataset metadata ${change.kind}: ${change.key}; review retained native values (not a biological change or cross-release identity claim)` }),
};
