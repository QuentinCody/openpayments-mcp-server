/**
 * Minimal BGZF (blocked gzip) reader for the EBI eQTL Catalogue FTP tree.
 *
 * A BGZF file is a concatenation of independent gzip members, each carrying an
 * RFC 1952 "BC" extra subfield holding BSIZE-1, the member's total compressed
 * length. Every member is a complete gzip stream on its own, so this reader
 * inflates them one at a time with `DecompressionStream("gzip")`. That keeps it
 * off workerd's multi-member gzip behaviour, which the WHATWG stream contract
 * does not pin down.
 *
 * The `.permuted.tsv.gz` and `.credible_sets.tsv.gz` files are plain
 * single-member gzip, not BGZF, so they go through `readGzipLines` instead.
 */

import { beforeDeadline } from "./release";

const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;
const CM_DEFLATE = 0x08;
const FEXTRA = 0x04;

/** BGZF caps one member at 65536 bytes; BSIZE is a uint16 holding size - 1. */
export const BGZF_MAX_BLOCK_SIZE = 65536;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_LINE_LENGTH = 1024 * 1024;

/** True when `offset` starts a deflate gzip member. */
export function isGzipMember(bytes: Uint8Array, offset = 0): boolean {
	return (
		offset + 3 <= bytes.length &&
		bytes[offset] === GZIP_ID1 &&
		bytes[offset + 1] === GZIP_ID2 &&
		bytes[offset + 2] === CM_DEFLATE
	);
}

/**
 * Total compressed length of the BGZF member starting at `offset`, read from
 * the "BC" extra subfield. Returns undefined when the member is not BGZF or
 * the buffer is truncated before the subfield.
 */
export function bgzfBlockSize(bytes: Uint8Array, offset = 0): number | undefined {
	if (!isGzipMember(bytes, offset)) return undefined;
	const flg = bytes[offset + 3];
	if ((flg & FEXTRA) === 0) return undefined;
	if (offset + 12 > bytes.length) return undefined;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const xlen = view.getUint16(offset + 10, true);
	let cursor = offset + 12;
	const extraEnd = cursor + xlen;
	if (extraEnd > bytes.length) return undefined;

	while (cursor + 4 <= extraEnd) {
		const si1 = bytes[cursor];
		const si2 = bytes[cursor + 1];
		const slen = view.getUint16(cursor + 2, true);
		if (cursor + 4 + slen > extraEnd) return undefined;
		if (si1 === 0x42 && si2 === 0x43 && slen === 2) {
			return view.getUint16(cursor + 4, true) + 1;
		}
		cursor += 4 + slen;
	}
	return undefined;
}

/** Inflate one complete gzip member. */
export async function inflateGzipMember(member: Uint8Array): Promise<Uint8Array> {
	// `slice` copies, so the Response never sees a view with a non-zero
	// byteOffset into a larger buffer.
	const source = new Response(member.slice());
	if (!source.body) throw new Error("BGZF: response body unavailable");
	const inflated = source.body.pipeThrough(new DecompressionStream("gzip"));
	const reader = inflated.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return concat(chunks, total);
			total += value.byteLength;
			if (total > BGZF_MAX_BLOCK_SIZE) throw new Error("BGZF: inflated member exceeds 65536 bytes");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

export interface BgzfInflateOptions {
	/** Byte offset of the first member inside `bytes` (default 0). */
	offset?: number;
	/** Stop after this many members; guards a runaway range read. */
	maxBlocks?: number;
}

/**
 * Inflate every complete BGZF member in `bytes` and concatenate the output.
 *
 * A trailing member that the buffer cuts short is dropped rather than
 * inflated — a range read normally ends mid-member, and half a member is not
 * recoverable data.
 */
export async function inflateBgzf(
	bytes: Uint8Array,
	opts?: BgzfInflateOptions,
): Promise<Uint8Array> {
	const maxBlocks = opts?.maxBlocks ?? Number.POSITIVE_INFINITY;
	const parts: Uint8Array[] = [];
	let total = 0;
	let cursor = opts?.offset ?? 0;
	let blocks = 0;

	while (cursor < bytes.length && blocks < maxBlocks) {
		const size = bgzfBlockSize(bytes, cursor);
		if (size === undefined) {
			if (cursor === (opts?.offset ?? 0)) {
				throw new Error(
					`BGZF: expected a BGZF member at byte ${cursor} (got ${[
						...bytes.slice(cursor, cursor + 4),
					]
						.map((b) => b.toString(16).padStart(2, "0"))
						.join(" ")})`,
				);
			}
			break;
		}
		if (cursor + size > bytes.length) break;
		const part = await inflateGzipMember(bytes.subarray(cursor, cursor + size));
		parts.push(part);
		total += part.length;
		if (total > MAX_INFLATED_BYTES) throw new Error("BGZF: inflated data exceeds 64 MiB; narrow the region");
		cursor += size;
		blocks += 1;
	}

	return concat(parts, total);
}

/**
 * The catalogue's TSV files are CRLF-terminated, so every line reader here
 * drops the carriage return. Leaving it on silently corrupts the last column
 * of every row (`rs4239702\r` instead of `rs4239702`).
 */
function stripCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Stream a plain (single-member) gzip body line by line.
 *
 * `onLine` returning false stops the read and cancels the body, so a filtered
 * scan of a multi-megabyte file never buffers the whole decompressed text.
 * Returns the number of lines handed to `onLine`.
 */
export async function readGzipLines(
	body: ReadableStream<Uint8Array>,
	onLine: (line: string) => boolean | void,
): Promise<number> {
	const stream = new Response(body).body!.pipeThrough(new DecompressionStream("gzip"));
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	let lines = 0;
	let inflatedBytes = 0;
	const deadlineAt = Date.now() + 25_000;

	try {
		while (true) {
			const { done, value } = await beforeDeadline(reader.read(), deadlineAt);
			if (done) break;
			inflatedBytes += value.byteLength;
			if (inflatedBytes > MAX_INFLATED_BYTES) throw new Error("gzip: inflated data exceeds 64 MiB; use offline analysis");
			pending += decoder.decode(value, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				if (newline > MAX_LINE_LENGTH) throw new Error("gzip: line exceeds 1 MiB");
				const line = stripCarriageReturn(pending.slice(0, newline));
				pending = pending.slice(newline + 1);
				lines += 1;
				if (onLine(line) === false) {
					return lines;
				}
				newline = pending.indexOf("\n");
			}
			if (pending.length > MAX_LINE_LENGTH) throw new Error("gzip: line exceeds 1 MiB");
		}
		pending += decoder.decode();
		if (pending.length > 0) {
			lines += 1;
			onLine(stripCarriageReturn(pending));
		}
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}

	return lines;
}

/**
 * Stream a BGZF body line by line, inflating one member at a time.
 *
 * Only the bytes of the member in flight are held, so a multi-megabyte range
 * read never materialises as one decompressed string. `onLine` returning false
 * stops the read and cancels the body — records are coordinate-sorted, so a
 * region scan can quit as soon as it passes the window.
 */
export async function readBgzfLines(
	body: ReadableStream<Uint8Array>,
	onLine: (line: string) => boolean | void,
	firstBlockOffset = 0,
): Promise<number> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending: Uint8Array = new Uint8Array(0);
	let text = "";
	let lines = 0;
	let stopped = false;
	let inflatedBytes = 0;
	let firstBlock = true;

	const emitLines = (): boolean => {
		let newline = text.indexOf("\n");
		while (newline >= 0) {
			if (newline > MAX_LINE_LENGTH) throw new Error("BGZF: line exceeds 1 MiB");
			const line = stripCarriageReturn(text.slice(0, newline));
			text = text.slice(newline + 1);
			lines += 1;
			if (onLine(line) === false) return false;
			newline = text.indexOf("\n");
		}
		if (text.length > MAX_LINE_LENGTH) throw new Error("BGZF: line exceeds 1 MiB");
		return true;
	};

	try {
		while (!stopped) {
			const { done, value } = await reader.read();
			if (value && value.length > 0) {
				pending = concat([pending, value], pending.length + value.length);
			}

			// Drain every member the buffer now holds in full.
			let cursor = 0;
			while (true) {
				const size = bgzfBlockSize(pending, cursor);
				if (size === undefined) {
					// A gzip magic with no readable BSIZE yet just means the
					// buffer stops inside the header; anything else is not BGZF.
					validatePartialMember(pending, cursor);
					break;
				}
				if (cursor + size > pending.length) break;
				const inflated = await inflateGzipMember(pending.subarray(cursor, cursor + size));
				inflatedBytes += inflated.byteLength;
				if (inflatedBytes > MAX_INFLATED_BYTES) throw new Error("BGZF: inflated data exceeds 64 MiB; narrow the region");
				cursor += size;
				const offset = firstBlock ? firstBlockOffset : 0;
				if (!Number.isInteger(offset) || offset < 0 || offset > inflated.length) throw new Error("BGZF: invalid first-record offset");
				text += decoder.decode(inflated.subarray(offset), { stream: true });
				firstBlock = false;
				if (!emitLines()) {
					stopped = true;
					break;
				}
			}
			pending = pending.slice(cursor);

			if (stopped) {
				await reader.cancel();
				return lines;
			}
			if (done) break;
		}

		// A byte range can end between members of a split row. Only newline-
		// terminated records establish a complete TSV row; discard its tail.
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}

	return lines;
}

function validatePartialMember(bytes: Uint8Array, cursor: number): void {
	if (bytes.length - cursor >= 4 && !isGzipMember(bytes, cursor)) {
		throw new Error(`BGZF: expected a BGZF member at stream byte ${cursor}`);
	}
}
