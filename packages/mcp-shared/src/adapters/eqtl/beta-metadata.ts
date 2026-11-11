import { eqtlError } from "./release";

export const R8_METADATA_URL = "https://raw.githubusercontent.com/eQTL-Catalogue/eQTL-Catalogue-resources/master/data_tables/dataset_metadata_r8_beta.tsv";
const REQUIRED = ["study_id", "dataset_id", "study_label", "sample_group", "tissue_id", "tissue_label", "condition_label", "sample_size", "quant_method", "pmid", "study_type"];

/** Keep every upstream column; no join with the r7 file map, even for reused IDs. */
export function parseBetaMetadata(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const columns = lines.shift()?.split("\t") ?? [];
  if (new Set(columns).size !== columns.length || REQUIRED.some(c => !columns.includes(c))) eqtlError("r8 metadata header changed", 502);
  const seen = new Set<string>();
  const datasets = lines.filter(Boolean).map(line => {
    const cells = line.split("\t");
    if (cells.length !== columns.length) eqtlError("r8 metadata row width changed", 502);
    const raw = Object.fromEntries(columns.map((c, i) => [c, cells[i]]));
    if (!/^QTD\d{6}$/.test(raw.dataset_id) || !/^QTS\d{6}$/.test(raw.study_id) || seen.has(raw.dataset_id)) eqtlError("invalid or duplicate r8 dataset identity", 502);
    seen.add(raw.dataset_id);
    const sampleSize = /^(?:NA)?$/.test(raw.sample_size) ? null : Number(raw.sample_size);
    if (sampleSize !== null && (!Number.isSafeInteger(sampleSize) || sampleSize < 0)) eqtlError("invalid r8 sample size", 502);
    return {
      study_id: raw.study_id, dataset_id: raw.dataset_id, study_label: raw.study_label,
      sample_group: raw.sample_group, tissue_id: raw.tissue_id, tissue_label: raw.tissue_label,
      condition_label: raw.condition_label, sample_size: sampleSize, quant_method: raw.quant_method,
      pmid: raw.pmid || null, study_type: raw.study_type || null,
      release: "r8_beta" as const, assembly: "GRCh38" as const, metadata: raw,
    };
  });
  if (!datasets.length) eqtlError("r8 metadata contains no datasets", 502);
  return datasets;
}

export type BetaDataset = ReturnType<typeof parseBetaMetadata>[number];
