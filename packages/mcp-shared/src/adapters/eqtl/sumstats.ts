import { BGZF_MAX_BLOCK_SIZE, readBgzfLines, readGzipLines } from "./bgzf";
import { assertFileHash, assertSameFile, type FileEvidence, readFileEvidence } from "./file-evidence";
import { loadHeaderEvidence, loadIndexEvidence } from "./indexed-file";

export { loadHeaderColumns, loadTabixIndex, resetFileCaches } from "./indexed-file";

import type { EqtlDataset } from "./ftp-catalogue";
import { ebiFileFetch } from "./http";
import {
	compressedOffset,
	queryChunks,
	resolveReferenceName,
	uncompressedOffset,
} from "./tabix";

/**
 * Reads over the eQTL Catalogue flat files: a tabix region slice of the
 * nominal summary statistics, and whole-file scans of the permuted top hits
 * and the SuSiE credible sets (neither of which ships an index).
 */

/** Columns that hold numbers in the catalogue's three table shapes. */
const NUMERIC_COLUMNS = new Set([
	"position",
	"ma_samples",
	"maf",
	"pvalue",
	"beta",
	"se",
	"ac",
	"an",
	"r2",
	"median_tpm",
	"n_traits",
	"n_variants",
	"p_perm",
	"p_beta",
	"pip",
	"z",
	"cs_min_r2",
	"cs_avg_r2",
	"cs_size",
	"cs_index",
	"cs_log10bf",
	"posterior_mean",
	"posterior_sd",
]);

/** A region wider than this is refused rather than dragged over the wire. */
const MAX_REGION_SPAN_BP = 5_000_000;
/** Cap on rows returned by one call before truncation is reported. */
export const DEFAULT_MAX_ROWS = 500;
export const HARD_MAX_ROWS = 20_000;

export type TableRow = Record<string, string | number | null>;

export interface TableResult {
	columns: string[];
	rows: TableRow[];
	row_count: number;
	/** True when the row cap stopped the scan before the data ran out. */
	truncated: boolean;
	source_file: string;
	lines_scanned: number;
}

export interface RegionResult extends TableResult {
	native_header: string;
	/** Decoded TSV rows aligned with rows; numeric text and NA/empty cells retained. CRLF is normalized. */
	raw_rows: string[];
	file_evidence: { index: FileEvidence; header: FileEvidence; range: FileEvidence | null };
	coverage_complete: false;
	chromosome: string;
	start: number;
	end: number;
	index_file: string;
	byte_range: { start: number; end: number } | null;
}

export function coerceRow(columns: string[], cells: string[]): TableRow {
	const row: TableRow = {};
	for (let i = 0; i < columns.length; i++) {
		const raw = cells[i];
		if (raw === undefined || raw === "" || raw === "NA") {
			row[columns[i]] = null;
			continue;
		}
		if (NUMERIC_COLUMNS.has(columns[i])) {
			const value = Number(raw);
			row[columns[i]] = Number.isFinite(value) ? value : raw;
			continue;
		}
		row[columns[i]] = raw;
	}
	return row;
}

export function clampMaxRows(requested: unknown): number {
	const value = Number(requested);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_ROWS;
	return Math.min(Math.floor(value), HARD_MAX_ROWS);
}

/** A caller error. Tagged so the tool layer answers 400, not 500. */
function badRequest(message: string): Error & { status: number } {
	const error = new Error(message) as Error & { status: number };
	error.status = 400;
	return error;
}

function unknownColumnError(
	unknown: string[],
	columns: string[],
	sourceFile: string,
): Error & { status: number } {
	return badRequest(
		`eQTL Catalogue: ${sourceFile} has no column ${unknown.map((name) => `"${name}"`).join(", ")} — ` +
			`the file's own header is: ${columns.join(", ")}`,
	);
}

export interface ResolvedFilter {
	column: string;
	at: number;
	value: string;
}

/**
 * Resolve each requested equality filter to its index in the file's own header.
 *
 * A filter naming a column the file does not have is a caller error, never a
 * row that fails to match. Matching it against every row would drop all of them
 * and report row_count 0 with success — a confident absence for data that is
 * really there. This throws a 400 naming the columns the file does have.
 */
export function resolveFilters(
	columns: string[],
	wanted: Record<string, string> | undefined,
	sourceFile: string,
): ResolvedFilter[] {
	const resolved: ResolvedFilter[] = [];
	const unknown: string[] = [];
	for (const [column, value] of Object.entries(wanted ?? {})) {
		if (value === undefined || value === "") continue;
		const at = columns.indexOf(column);
		if (at === -1) unknown.push(column);
		else resolved.push({ column, at, value });
	}
	if (unknown.length > 0) throw unknownColumnError(unknown, columns, sourceFile);
	return resolved;
}

/** Same contract as `resolveFilters`, for a numeric bound on one column. */
export function resolveBound(
	columns: string[],
	bound: { column: string; value: number } | undefined,
	sourceFile: string,
): { at: number; value: number } | undefined {
	if (!bound) return undefined;
	const at = columns.indexOf(bound.column);
	if (at === -1) throw unknownColumnError([bound.column], columns, sourceFile);
	return { at, value: bound.value };
}


export interface RegionQuery {
	index_sha256?: string;
	header_sha256?: string;
	range_sha256?: string;
	dataset: EqtlDataset;
	chromosome: string;
	/** 1-based inclusive. */
	start: number;
	/** 1-based inclusive. */
	end: number;
	maxRows?: number;
	/** Extra equality filters applied to the decoded rows. */
	rowFilters?: Record<string, string>;
}

/**
 * Fetch every nominal association in a genomic window, using the tabix index to
 * turn the window into a single byte range.
 *
 * The files are indexed by coordinate only. A gene- or rsID-centric question
 * must resolve to GRCh38 coordinates first (the ensembl, gnomad or gwas-catalog
 * servers do that); `rowFilters` then narrows the window's rows.
 */
export async function queryRegion(query: RegionQuery, io = { loadIndexEvidence, loadHeaderEvidence, fetchFile: ebiFileFetch }): Promise<RegionResult> {
	const { dataset, start, end, maxRows, index, referenceName, reference, header, columns, filters, base } = await prepareRegionQuery(query, io);

	const chunks = queryChunks(reference, start - 1, end);
	if (chunks.length === 0) {
		// The observed index reports no covering block; this does not establish
		// completeness or that an independently fetched index matches the data file.
		if (query.range_sha256) throw Object.assign(new Error("eQTL Catalogue: no range exists to verify range_sha256"), { status: 409 });
		return { ...base, rows: [], raw_rows: [], row_count: 0, truncated: false, lines_scanned: 0 };
	}

	const { byteStart, byteEnd } = regionByteRange(chunks);

	const seqColumn = index.colSeq - 1;
	const posColumn = index.colBeg - 1;

	const rows: TableRow[] = [];
	const rawRows: string[] = [];
	let truncated = false;

	const observed = await readRegionEvidence(query, io.fetchFile, header, { start: byteStart, end: byteEnd });
	const linesScanned = await readBgzfLines(new Response(observed.bytes.slice()).body!, (line) => {
		if (line.length === 0 || line.startsWith(index.meta)) return;
		const cells = line.split("\t");
		// The tabix virtual offset starts at a record boundary. A shifted row
		// is malformed, not evidence that this window has no matching results.
		if (cells.length !== columns.length) throw new Error("eQTL Catalogue: association row width differs from its header");
		if (cells[seqColumn] !== referenceName) return;
		const position = Number(cells[posColumn]);
		if (!Number.isFinite(position)) return;
		if (position < start) return;
		// Records are coordinate-sorted, so the first row past the window ends
		// the scan instead of streaming the rest of the byte range.
		if (position > end) return false;
		for (const filter of filters) {
			if (cells[filter.at] !== filter.value) return;
		}
		if (rows.length >= maxRows) {
			truncated = true;
			return false;
		}
		rows.push(coerceRow(columns, cells));
		rawRows.push(line);
	}, uncompressedOffset(chunks[0].begin));

	return {
		...base,
		byte_range: { start: byteStart, end: byteEnd },
		file_evidence: { ...base.file_evidence, range: observed.evidence },
		rows,
		raw_rows: rawRows,
		row_count: rows.length,
		truncated,
		lines_scanned: linesScanned,
	};
}

export interface WholeFileQuery {
	url: string;
	expected_sha256?: string;
	maxRows?: number;
	/** Equality filters on decoded columns. */
	rowFilters?: Record<string, string>;
	/** Optional upper bound on a numeric column (for example p_beta). */
	numericMax?: { column: string; value: number };
	/** Optional lower bound on a numeric column (for example pip). */
	numericMin?: { column: string; value: number };
}

export interface WholeFileResult extends TableResult {
	native_header: string;
	raw_rows: string[];
	file_evidence: FileEvidence;
	coverage_complete: false;
}

/**
 * Read a complete bounded compressed file for its byte proof, then stream its
 * decoded rows. No tabix index exists for these files. The row cap may stop
 * decoding early; complete compressed bytes do not establish complete rows.
 */
export async function readTsvGz(query: WholeFileQuery, fetchFile: typeof ebiFileFetch = ebiFileFetch, signal?: AbortSignal): Promise<WholeFileResult> {
	signal?.throwIfAborted();
	const maxRows = clampMaxRows(query.maxRows);
	const response = await fetchFile(query.url, { timeout: 45_000, deadlineMs: 90_000 });
	if (!response.body) throw new Error(`eQTL Catalogue: empty body for ${query.url}`);
	const file = await readFileEvidence(response, query.url, 16 * 1024 * 1024);
	signal?.throwIfAborted();
	assertFileHash(file.evidence, query.expected_sha256);

	const { columns, nativeHeader, rows, rawRows, truncated, columnError, linesScanned } = await readTsvRows(query, maxRows, file, signal);

	if (columnError) throw columnError;
	if (columns.length === 0) {
		// No header line at all: the read failed or the file is not the table it
		// claims to be. Reporting that as an empty result would be a lie.
		throw new Error(`eQTL Catalogue: no header row found in ${query.url}`);
	}

	return {
		native_header: nativeHeader,
		raw_rows: rawRows,
		file_evidence: file.evidence,
		coverage_complete: false,
		columns,
		rows,
		row_count: rows.length,
		truncated,
		source_file: query.url,
		lines_scanned: linesScanned,
	};
}

async function prepareRegionQuery(query: RegionQuery, io: { loadIndexEvidence: typeof loadIndexEvidence; loadHeaderEvidence: typeof loadHeaderEvidence; fetchFile: typeof ebiFileFetch }) {
	const { dataset, chromosome, start, end } = query;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
		throw badRequest(
			`eQTL Catalogue: invalid region ${chromosome}:${start}-${end} (1-based inclusive, end >= start)`,
		);
	}
	if (end - start + 1 > MAX_REGION_SPAN_BP) {
		throw badRequest(
			`eQTL Catalogue: region span ${end - start + 1} bp exceeds the ${MAX_REGION_SPAN_BP} bp limit — narrow the window`,
		);
	}

	const maxRows = clampMaxRows(query.maxRows);
	const indexResult = await io.loadIndexEvidence(dataset.sumstats_index_url);
	assertFileHash(indexResult.evidence, query.index_sha256);
	const index = indexResult.index;
	const referenceName = resolveReferenceName(index, chromosome);
	if (referenceName === undefined) {
		throw badRequest(
			`eQTL Catalogue: ${dataset.dataset_id} has no chromosome "${chromosome}" (indexed: ${index.names.join(", ")})`,
		);
	}
	const reference = index.refs.get(referenceName);
	if (!reference) {
		throw new Error(`eQTL Catalogue: index for ${referenceName} is missing from the .tbi`);
	}

	const header = await io.loadHeaderEvidence(dataset.sumstats_url);
	assertFileHash(header.evidence, query.header_sha256);
	const columns = header.columns;
	// Before anything can return zero rows: every filter column must exist in
	// the file's own header, or the "no rows" answer would be manufactured.
	const filters = resolveFilters(columns, query.rowFilters, dataset.sumstats_url);
	const base: Omit<RegionResult, "rows" | "raw_rows" | "row_count" | "truncated" | "lines_scanned"> = {
		native_header: header.line,
		file_evidence: { index: indexResult.evidence, header: header.evidence, range: null },
		coverage_complete: false,
		columns,
		chromosome: referenceName,
		start,
		end,
		source_file: dataset.sumstats_url,
		index_file: dataset.sumstats_index_url,
		byte_range: null,
	};
	return { dataset, start, end, maxRows, index, referenceName, reference, header, columns, filters, base };
}

function regionByteRange(chunks: ReturnType<typeof queryChunks>) {
	let byteStart = Number.POSITIVE_INFINITY;
	let byteEnd = 0;
	for (const chunk of chunks) {
		byteStart = Math.min(byteStart, compressedOffset(chunk.begin));
		byteEnd = Math.max(byteEnd, compressedOffset(chunk.end) + BGZF_MAX_BLOCK_SIZE - 1);
	}
	return { byteStart, byteEnd };
}

async function readTsvRows(query: WholeFileQuery, maxRows: number, file: Awaited<ReturnType<typeof readFileEvidence>>, signal?: AbortSignal) {
	let columns: string[] = [];
	let nativeHeader = "";
	const rows: TableRow[] = [];
	const rawRows: string[] = [];
	let truncated = false;
	// These files carry no index, so the header only arrives with the stream.
	// The filter columns are checked against it on the header line and the scan
	// is stopped there — an unknown column ends the call loudly instead of
	// dropping every row and reporting a zero the data does not support.
	let filters: ResolvedFilter[] = [];
	let numericMax: { at: number; value: number } | undefined;
	let numericMin: { at: number; value: number } | undefined;
	let columnError: Error | undefined;

	const linesScanned = await readGzipLines(new Response(file.bytes.slice().buffer).body!, (line) => {
		signal?.throwIfAborted();
		if (line.length === 0) return;
		const cells = line.split("\t");
		if (columns.length === 0) {
			nativeHeader = line;
			columns = cells.map((cell) => cell.replace(/^#/, ""));
			if (columns.some(column => !column) || new Set(columns).size !== columns.length) throw new Error("eQTL Catalogue: invalid or duplicate TSV columns");
			try {
				filters = resolveFilters(columns, query.rowFilters, query.url);
				numericMax = resolveBound(columns, query.numericMax, query.url);
				numericMin = resolveBound(columns, query.numericMin, query.url);
			} catch (error) {
				columnError = error as Error;
				return false;
			}
			return;
		}
		if (cells.length !== columns.length) throw new Error("eQTL Catalogue: malformed complete TSV row");
		for (const filter of filters) {
			if (cells[filter.at] !== filter.value) return;
		}
		if (!satisfiesNumericBounds(cells, numericMax, numericMin)) return;
		if (rows.length >= maxRows) {
			truncated = true;
			return false;
		}
		rows.push(coerceRow(columns, cells));
		rawRows.push(line);
	});
	return { columns, nativeHeader, rows, rawRows, truncated, columnError, linesScanned };
}

async function readRegionEvidence(query: RegionQuery, fetchFile: typeof ebiFileFetch, header: Awaited<ReturnType<typeof loadHeaderEvidence>>, range: { start: number; end: number }) {
	const { start: byteStart, end: byteEnd } = range;
	if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) || byteEnd - byteStart + 1 > 16 * 1024 * 1024) {
		throw badRequest("eQTL Catalogue: compressed region exceeds 16 MiB; narrow the window");
	}
	const response = await fetchFile(query.dataset.sumstats_url, {
		range: { start: byteStart, end: byteEnd },
		timeout: 30_000,
		deadlineMs: 60_000,
	});
	const observed = await readFileEvidence(response, query.dataset.sumstats_url, 16 * 1024 * 1024, range);
	assertFileHash(observed.evidence, query.range_sha256);
	assertSameFile(header.evidence, observed.evidence);
	return observed;
}

function satisfiesNumericBounds(cells: string[], numericMax: { at: number; value: number } | undefined, numericMin: { at: number; value: number } | undefined): boolean {
		if (numericMax) {
			if (cells[numericMax.at] === "" || cells[numericMax.at] === "NA") return false;
			const value = Number(cells[numericMax.at]);
			if (!Number.isFinite(value) || value > numericMax.value) return false;
		}
		if (numericMin) {
			if (cells[numericMin.at] === "" || cells[numericMin.at] === "NA") return false;
			const value = Number(cells[numericMin.at]);
			if (!Number.isFinite(value) || value < numericMin.value) return false;
		}
	return true;
}
