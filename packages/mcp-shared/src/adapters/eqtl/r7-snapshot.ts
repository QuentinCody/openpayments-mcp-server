import { eqtlError, hashParam } from "./release";

type Row = Record<string, string>;
const IDENTITY_COLUMNS = ["study_id", "dataset_id", "study_label", "sample_group", "tissue_id", "tissue_label", "condition_label", "sample_size", "quant_method"];

/** Reject schema drift before joining: duplicate headers must not overwrite cells. */
export function parseR7Table(text: string, kind: "paths" | "metadata"): Row[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const columns = lines.shift()?.split("\t") ?? [];
  const required = [...IDENTITY_COLUMNS, ...(kind === "paths" ? ["ftp_path", "ftp_cs_path", "ftp_lbf_path"] : ["pmid", "study_type"])];
  if (new Set(columns).size !== columns.length || required.some(column => !columns.includes(column))) eqtlError(`r7 ${kind} header changed`, 502);
  return lines.filter(line => line.length > 0).map(line => {
    const cells = line.split("\t");
    if (cells.length !== columns.length) eqtlError(`r7 ${kind} row width changed`, 502);
    return Object.fromEntries(columns.map((column, index) => [column, cells[index]]));
  });
}

/** A reused QTD ID is not enough to join analyses across releases. */
export function r7MetadataById(paths: Row[], metadata: Row[]): Map<string, Row> {
  const byId = new Map<string, Row>();
  for (const row of metadata) {
    if (!/^QTD\d{6}$/.test(row.dataset_id) || byId.has(row.dataset_id)) eqtlError("invalid or duplicate r7 metadata dataset identity", 502);
    byId.set(row.dataset_id, row);
  }
  const seen = new Set<string>();
  for (const row of paths) {
    if (!/^QTD\d{6}$/.test(row.dataset_id) || seen.has(row.dataset_id)) eqtlError("invalid or duplicate r7 file-map dataset identity", 502);
    seen.add(row.dataset_id);
    const matched = byId.get(row.dataset_id);
    if (!matched) eqtlError(`file-map dataset ${row.dataset_id} is absent from r7 metadata`, 502);
    // The published tables disagree on some sample sizes; preserve both below.
    for (const column of IDENTITY_COLUMNS.filter(column => column !== "sample_size")) {
      if (row[column] === undefined || matched[column] === undefined || row[column] !== matched[column]) {
        eqtlError(`r7 file map and metadata disagree on ${row.dataset_id} ${column}`, 502);
      }
    }
    if (!row.ftp_path?.trim()) eqtlError(`r7 dataset ${row.dataset_id} has no summary-statistics path`, 502);
  }
  return byId;
}

export interface R7Snapshot {
  release: "r7";
  metadata_sha256: string;
  paths_sha256: string;
  retrieved_at: string;
}

export function r7SnapshotPins(params: Record<string, unknown>) {
  if (params.file_sha256 !== undefined || params.file_role !== undefined) eqtlError("Parquet file parameters require release r8_beta");
  return {
    metadata_sha256: hashParam(params.metadata_sha256, "metadata_sha256"),
    paths_sha256: hashParam(params.paths_sha256, "paths_sha256"),
  };
}

export function assertR7Snapshot(snapshot: R7Snapshot | undefined, pins: ReturnType<typeof r7SnapshotPins>): R7Snapshot {
  if (!snapshot) eqtlError("r7 catalogue snapshot evidence is missing", 502);
  for (const key of ["metadata_sha256", "paths_sha256"] as const) {
    if (pins[key] && pins[key] !== snapshot[key]) eqtlError(`r7 ${key} changed; rediscover the catalogue before continuing`, 409);
  }
  return snapshot;
}
