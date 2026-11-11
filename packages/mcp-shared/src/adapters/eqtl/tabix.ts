/**
 * Tabix (.tbi) index reader — enough of the format to turn a genomic region
 * into the byte range of the BGZF file that holds it.
 *
 * Layout (htslib tbi_index): magic "TBI\1", n_ref, format, col_seq, col_beg,
 * col_end, meta, skip, l_nm, NUL-separated reference names, then per reference
 * a bin index (bin id, chunk list of virtual-offset pairs) and a linear index
 * of virtual offsets, one per 16 kb window.
 *
 * A virtual offset packs the BGZF member's byte offset in the high 48 bits and
 * the offset inside the inflated member in the low 16. Files here are ~3 GB, so
 * a virtual offset stays well under Number.MAX_SAFE_INTEGER once converted.
 */

const TBI_MAGIC = 0x01494254; // "TBI\1" little-endian
const LINEAR_INDEX_SHIFT = 14;

export interface TabixChunk {
	/** Virtual offset of the first record. */
	begin: number;
	/** Virtual offset just past the last record. */
	end: number;
}

export interface TabixReference {
	bins: Map<number, TabixChunk[]>;
	/** Linear index: virtual offset of the first record in each 16 kb window. */
	intervals: number[];
}

export interface TabixIndex {
	format: number;
	/** 1-based column of the sequence name. */
	colSeq: number;
	/** 1-based column of the region start. */
	colBeg: number;
	/** 1-based column of the region end (0 when the format has none). */
	colEnd: number;
	/** Comment/meta character; lines starting with it are not records. */
	meta: string;
	/** Number of header lines skipped at the top of the file. */
	skip: number;
	names: string[];
	refs: Map<string, TabixReference>;
}

/** Byte offset of the BGZF member a virtual offset points into. */
export function compressedOffset(virtualOffset: number): number {
	return Math.floor(virtualOffset / 65536);
}

/** Offset inside the inflated member a virtual offset points at. */
export function uncompressedOffset(virtualOffset: number): number {
	return virtualOffset % 65536;
}

function readVirtualOffset(view: DataView, at: number): number {
	const value = view.getBigUint64(at, true);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`tabix: virtual offset ${value} exceeds the safe integer range`);
	}
	return Number(value);
}

/**
 * Bin ids that can hold a record overlapping the 0-based half-open [beg, end).
 * The five levels are the fixed tabix/BAI binning scheme.
 */
export function reg2bins(beg: number, end: number): number[] {
	const last = Math.max(beg, end - 1);
	const bins: number[] = [0];
	const levels: Array<[number, number]> = [
		[1, 26],
		[9, 23],
		[73, 20],
		[585, 17],
		[4681, 14],
	];
	for (const [base, shift] of levels) {
		for (let k = base + (beg >> shift); k <= base + (last >> shift); k++) {
			bins.push(k);
		}
	}
	return bins;
}

/** Parse an inflated .tbi index. */
export function parseTabixIndex(bytes: Uint8Array): TabixIndex {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 36 || view.getUint32(0, true) !== TBI_MAGIC) {
		throw new Error("tabix: not a TBI index (bad magic)");
	}

	const nRef = view.getInt32(4, true);
	const format = view.getInt32(8, true);
	const colSeq = view.getInt32(12, true);
	const colBeg = view.getInt32(16, true);
	const colEnd = view.getInt32(20, true);
	const metaChar = view.getInt32(24, true);
	const skip = view.getInt32(28, true);
	const nameBlockLength = view.getInt32(32, true);

	let cursor = 36;
	const nameBlock = new TextDecoder().decode(bytes.subarray(cursor, cursor + nameBlockLength));
	cursor += nameBlockLength;
	const names = nameBlock.split("\0").filter((name) => name.length > 0);

	const refs = new Map<string, TabixReference>();
	for (let refIndex = 0; refIndex < nRef; refIndex++) {
		const bins = new Map<number, TabixChunk[]>();
		const binCount = view.getInt32(cursor, true);
		cursor += 4;
		for (let b = 0; b < binCount; b++) {
			const binId = view.getUint32(cursor, true);
			cursor += 4;
			const chunkCount = view.getInt32(cursor, true);
			cursor += 4;
			const chunks: TabixChunk[] = [];
			for (let c = 0; c < chunkCount; c++) {
				chunks.push({
					begin: readVirtualOffset(view, cursor),
					end: readVirtualOffset(view, cursor + 8),
				});
				cursor += 16;
			}
			bins.set(binId, chunks);
		}

		const intervalCount = view.getInt32(cursor, true);
		cursor += 4;
		const intervals: number[] = [];
		for (let i = 0; i < intervalCount; i++) {
			intervals.push(readVirtualOffset(view, cursor));
			cursor += 8;
		}

		const name = names[refIndex];
		if (name !== undefined) refs.set(name, { bins, intervals });
	}

	return {
		format,
		colSeq,
		colBeg,
		colEnd,
		meta: String.fromCharCode(metaChar),
		skip,
		names,
		refs,
	};
}

/**
 * Resolve a caller's chromosome to the name the index actually uses.
 * The name set is whatever that dataset's own .tbi carries, and it varies:
 * QTD000021's index holds "1".."22" and no sex chromosome, QTD000244's holds
 * "1".."22" plus "X" (both read from the live .tbi headers, 2026-08-27). A
 * leading "chr" is accepted and stripped. Returns undefined when nothing
 * matches, so the caller can report the real name list instead of silently
 * finding nothing.
 */
export function resolveReferenceName(index: TabixIndex, chromosome: string): string | undefined {
	const raw = chromosome.trim();
	const stripped = raw.replace(/^chr/i, "");
	for (const candidate of [raw, stripped, `chr${stripped}`]) {
		if (index.refs.has(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Chunks that can contain records overlapping [beg, end), 0-based half-open,
 * merged and sorted. Chunks ending before the linear index's offset for the
 * first 16 kb window are dropped — that is the filter that keeps a point query
 * down to a single small range read.
 */
export function queryChunks(reference: TabixReference, beg: number, end: number): TabixChunk[] {
	const window = beg >> LINEAR_INDEX_SHIFT;
	const minOffset =
		reference.intervals.length === 0
			? 0
			: (reference.intervals[Math.min(window, reference.intervals.length - 1)] ?? 0);

	const selected: TabixChunk[] = [];
	for (const binId of reg2bins(beg, end)) {
		for (const chunk of reference.bins.get(binId) ?? []) {
			if (chunk.end > minOffset) selected.push(chunk);
		}
	}
	selected.sort((a, b) => a.begin - b.begin);

	const merged: TabixChunk[] = [];
	for (const chunk of selected) {
		const previous = merged[merged.length - 1];
		// Merge chunks that land in the same BGZF member; anything finer would
		// still cost the same single member read.
		if (previous && compressedOffset(chunk.begin) <= compressedOffset(previous.end)) {
			previous.end = Math.max(previous.end, chunk.end);
		} else {
			merged.push({ ...chunk });
		}
	}
	return merged;
}
