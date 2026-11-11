import { resourcesFetch, toHttpsUrl } from "./http";
import { parseR7Table, type R7Snapshot, r7MetadataById } from "./r7-snapshot";
import { boundedText, sha256 } from "./release";

/**
 * Dataset catalogue, rebuilt from the eQTL-Catalogue-resources repository.
 *
 * `tabix/tabix_ftp_paths.tsv` is the authoritative dataset -> file map: it
 * already names the correct summary-statistics file per dataset, which matters
 * because only `ge` and `microarray` datasets publish `.all.tsv.gz` while
 * `exon` / `tx` / `txrev` / `leafcutter` publish `.cc.tsv.gz`. The path is read
 * from that table, never assembled from a suffix guess.
 *
 * `data_tables/dataset_metadata_r7.tsv` adds `pmid` and `study_type`. This
 * resolver is r7-only. r8_beta uses separate metadata and Parquet manifests.
 */

const PATHS_TABLE = "/tabix/tabix_ftp_paths.tsv";
const METADATA_TABLE = "/data_tables/dataset_metadata_r7.tsv";

export interface EqtlDataset {
	catalogue_snapshot?: R7Snapshot;
	study_id: string;
	dataset_id: string;
	study_label: string;
	sample_group: string;
	tissue_id: string;
	tissue_label: string;
	condition_label: string;
	sample_size: number | null;
	/** Legacy sample_size uses the file map; retain both native claims when they differ. */
	sample_size_provenance?: { selected_source: "file_map"; file_map_value: string; metadata_value: string; agreement: boolean };
	quant_method: string;
	study_type: string | null;
	pmid: string | null;
	/** Nominal cis summary statistics, bgzip + tabix indexed. */
	sumstats_url: string;
	sumstats_index_url: string;
	/** Per-trait permutation top hits. Whole-file read, no index. */
	permuted_url: string | null;
	/** SuSiE fine-mapped credible sets. Whole-file read, no index. */
	credible_sets_url: string | null;
	/** SuSiE log Bayes factors. Whole-file read, no index. */
	lbf_url: string | null;
}

export interface EqtlStudy {
	study_id: string;
	study_label: string;
	study_type: string | null;
	pmid: string | null;
	dataset_count: number;
	quant_methods: string[];
	tissue_labels: string[];
	sample_size_max: number | null;
}

/** Parse a tab-separated table with a header row into keyed rows. */
export function parseTsv(text: string): Record<string, string>[] {
	const lines = text.split("\n");
	let index = 0;
	while (index < lines.length && lines[index].trim().length === 0) index += 1;
	if (index >= lines.length) return [];

	const header = lines[index].replace(/\r$/, "").split("\t");
	const rows: Record<string, string>[] = [];
	for (let i = index + 1; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/, "");
		if (line.length === 0) continue;
		const cells = line.split("\t");
		const row: Record<string, string> = {};
		for (let c = 0; c < header.length; c++) row[header[c]] = cells[c] ?? "";
		rows.push(row);
	}
	return rows;
}

function toNumber(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function orNull(value: string | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed.length > 0 && trimmed !== "NA" ? trimmed : null;
}

/** Permuted top hits sit beside the nominal file under the same dataset directory. */
function permutedUrlFor(sumstatsUrl: string): string | null {
	const match = sumstatsUrl.match(/^(.*)\.(all|cc)\.tsv\.gz$/);
	return match ? `${match[1]}.permuted.tsv.gz` : null;
}

/** Join the FTP path table with the r7 metadata table into dataset records. */
export function buildDatasets(
	pathRows: Record<string, string>[],
	metadataRows: Record<string, string>[],
): EqtlDataset[] {
	const metadataById = r7MetadataById(pathRows, metadataRows);

	const datasets: EqtlDataset[] = [];
	for (const row of pathRows) {
		const sumstatsUrl = toHttpsUrl(row.ftp_path.trim());
		const metadata = metadataById.get(row.dataset_id);
		datasets.push({
			study_id: row.study_id,
			dataset_id: row.dataset_id,
			study_label: row.study_label,
			sample_group: row.sample_group,
			tissue_id: row.tissue_id,
			tissue_label: row.tissue_label,
			condition_label: row.condition_label,
			sample_size: toNumber(row.sample_size),
			sample_size_provenance: {
				selected_source: "file_map", file_map_value: row.sample_size,
				metadata_value: metadata!.sample_size, agreement: row.sample_size === metadata!.sample_size,
			},
			quant_method: row.quant_method,
			study_type: orNull(metadata?.study_type),
			pmid: orNull(metadata?.pmid),
			sumstats_url: sumstatsUrl,
			sumstats_index_url: `${sumstatsUrl}.tbi`,
			permuted_url: permutedUrlFor(sumstatsUrl),
			credible_sets_url: row.ftp_cs_path ? toHttpsUrl(row.ftp_cs_path.trim()) : null,
			lbf_url: row.ftp_lbf_path ? toHttpsUrl(row.ftp_lbf_path.trim()) : null,
		});
	}
	return datasets;
}

let datasetCache: Promise<EqtlDataset[]> | undefined;

/** Load (and memoize for the isolate's lifetime) the full dataset catalogue. */
export function loadDatasets(): Promise<EqtlDataset[]> {
	if (!datasetCache) {
		datasetCache = fetchDatasets().catch((error) => {
			datasetCache = undefined;
			throw error;
		});
	}
	return datasetCache;
}

/** Same r7 join with a request-scoped transport for bounded composite workflows. */
export async function fetchDatasets(fetchResources: typeof resourcesFetch = resourcesFetch): Promise<EqtlDataset[]> {
	const [paths, metadata] = await Promise.all([
		fetchResources(PATHS_TABLE).then((r) => boundedText(r)),
		fetchResources(METADATA_TABLE).then((r) => boundedText(r)),
	]);
	const datasets = buildDatasets(parseR7Table(paths, "paths"), parseR7Table(metadata, "metadata"));
	const snapshot = { release: "r7" as const, metadata_sha256: await sha256(metadata), paths_sha256: await sha256(paths), retrieved_at: new Date().toISOString() };
	for (const dataset of datasets) dataset.catalogue_snapshot = snapshot;
	if (datasets.length === 0) {
		throw new Error(
			`eQTL Catalogue: ${PATHS_TABLE} parsed to zero datasets — the upstream table shape changed`,
		);
	}
	return datasets;
}

/** Drop the memoized catalogue. For tests. */
export function resetDatasetCache(): void {
	datasetCache = undefined;
}

export interface DatasetFilters {
	dataset_id?: string;
	study_id?: string;
	study_label?: string;
	quant_method?: string;
	tissue_label?: string;
	tissue_id?: string;
	sample_group?: string;
	condition_label?: string;
	study_type?: string;
	/** Free-text match across the label, tissue, sample group, and condition. */
	search?: string;
}

function matches(actual: string | null, wanted: string | undefined): boolean {
	if (wanted === undefined || wanted === "") return true;
	return (actual ?? "").toLowerCase() === wanted.toLowerCase();
}

export function filterDatasets<T extends Omit<EqtlDataset, "sumstats_url" | "sumstats_index_url" | "permuted_url" | "credible_sets_url" | "lbf_url">>(datasets: T[], filters: DatasetFilters): T[] {
	const search = filters.search?.toLowerCase();
	return datasets.filter((dataset) => {
		if (!matches(dataset.dataset_id, filters.dataset_id)) return false;
		if (!matches(dataset.study_id, filters.study_id)) return false;
		if (!matches(dataset.study_label, filters.study_label)) return false;
		if (!matches(dataset.quant_method, filters.quant_method)) return false;
		if (!matches(dataset.tissue_label, filters.tissue_label)) return false;
		if (!matches(dataset.tissue_id, filters.tissue_id)) return false;
		if (!matches(dataset.sample_group, filters.sample_group)) return false;
		if (!matches(dataset.condition_label, filters.condition_label)) return false;
		if (!matches(dataset.study_type, filters.study_type)) return false;
		if (search) {
			const haystack = [
				dataset.study_label,
				dataset.tissue_label,
				dataset.sample_group,
				dataset.condition_label,
				dataset.dataset_id,
				dataset.study_id,
			]
				.join(" ")
				.toLowerCase();
			if (!haystack.includes(search)) return false;
		}
		return true;
	});
}

/** Collapse datasets into one row per study — the retired /studies surface. */
export function summarizeStudies<T extends Omit<EqtlDataset, "sumstats_url" | "sumstats_index_url" | "permuted_url" | "credible_sets_url" | "lbf_url">>(datasets: T[]): EqtlStudy[] {
	const byStudy = new Map<string, T[]>();
	for (const dataset of datasets) {
		const bucket = byStudy.get(dataset.study_id);
		if (bucket) bucket.push(dataset);
		else byStudy.set(dataset.study_id, [dataset]);
	}

	const studies: EqtlStudy[] = [];
	for (const [studyId, members] of byStudy) {
		const sizes = members
			.map((member) => member.sample_size)
			.filter((size): size is number => size !== null);
		studies.push({
			study_id: studyId,
			study_label: members[0].study_label,
			study_type: members[0].study_type,
			pmid: members[0].pmid,
			dataset_count: members.length,
			quant_methods: [...new Set(members.map((member) => member.quant_method))].sort(),
			tissue_labels: [...new Set(members.map((member) => member.tissue_label))].sort(),
			sample_size_max: sizes.length > 0 ? Math.max(...sizes) : null,
		});
	}
	studies.sort((a, b) => a.study_id.localeCompare(b.study_id));
	return studies;
}
