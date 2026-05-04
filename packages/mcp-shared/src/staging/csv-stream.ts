/**
 * Streaming CSV → row iterator for bulk-ingest servers whose source files
 * exceed Worker memory (DepMap matrices are ~60 MB; 128 MB Worker heap
 * cannot afford to buffer the whole file as text).
 *
 * Usage:
 *
 *   for await (const row of csvStream(response.body!)) {
 *     // row: Record<string, unknown> — same shape as parseCsv() result
 *   }
 *
 * The state machine is the same one used by {@link parseCsv} so quoted
 * fields with embedded commas, newlines, and escaped double-quotes are
 * handled correctly across chunk boundaries — including UTF-8 multi-byte
 * characters split between chunks (TextDecoder is used in streaming mode).
 *
 * Numeric column classification works on a buffered prefix of
 * {@link CsvStreamOptions.numericDetectionSampleSize} rows (default 100).
 * Once classification is decided, the buffered rows are emitted in order,
 * then the remainder of the stream is processed lazily.
 */

import type { ParseCsvOptions } from "./csv-parser";

export interface CsvStreamOptions
    extends Pick<ParseCsvOptions, "stripHeaderQuotes"> {
    /**
     * If true (default), columns are auto-cast to numbers based on a sample
     * of the first {@link numericDetectionSampleSize} rows. The sample is
     * collected by buffering rows internally before any are yielded.
     */
    readonly autoCastNumbers?: boolean;
    /**
     * Number of leading rows held back for numeric column classification
     * before any rows are emitted. Default 100. Smaller values reduce
     * memory at the cost of classification accuracy on heterogeneous
     * leading rows. Set to 0 to skip detection entirely.
     */
    readonly numericDetectionSampleSize?: number;
}

const DEFAULT_NUMERIC_SAMPLE_SIZE = 100;
const NUMERIC_CLASSIFICATION_THRESHOLD = 0.75;

interface ParserState {
    field: string;
    current: string[];
    inQuotes: boolean;
    /**
     * True iff the prior character was '\r' and we have not yet decided
     * whether it's standalone (legacy Mac, treat as newline) or part of a
     * \r\n pair. We defer the row emission decision until the next
     * character so the \n in \r\n doesn't fire a second blank row.
     */
    pendingCR: boolean;
}

function newParserState(): ParserState {
    return { field: "", current: [], inQuotes: false, pendingCR: false };
}

/**
 * Feed one chunk of decoded text into the parser, emitting any complete
 * rows as side effects via {@link onRow}. Partial rows remain in state.
 */
function feedChunk(
    state: ParserState,
    text: string,
    onRow: (row: string[]) => void,
): void {
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (state.pendingCR) {
            state.pendingCR = false;
            if (ch === "\n") {
                continue; // \r\n — already emitted on the \r; consume \n.
            }
        }

        if (state.inQuotes) {
            if (ch === '"') {
                if (i + 1 < text.length && text[i + 1] === '"') {
                    state.field += '"';
                    i++;
                } else {
                    state.inQuotes = false;
                }
            } else {
                state.field += ch;
            }
        } else if (ch === '"') {
            state.inQuotes = true;
        } else if (ch === ",") {
            state.current.push(state.field.trim());
            state.field = "";
        } else if (ch === "\n") {
            state.current.push(state.field.trim());
            state.field = "";
            if (state.current.some((f) => f !== "")) onRow(state.current);
            state.current = [];
        } else if (ch === "\r") {
            state.current.push(state.field.trim());
            state.field = "";
            if (state.current.some((f) => f !== "")) onRow(state.current);
            state.current = [];
            state.pendingCR = true;
        } else {
            state.field += ch;
        }
    }
}

function finalizeState(
    state: ParserState,
    onRow: (row: string[]) => void,
): void {
    if (state.field || state.current.length > 0) {
        state.current.push(state.field.trim());
        if (state.current.some((f) => f !== "")) onRow(state.current);
    }
}

function isNumericString(s: string): boolean {
    if (s === "") return false;
    if (s.length > 1 && s[0] === "0" && s[1] !== ".") return false;
    return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s);
}

function classifyNumericColumns(
    headerCount: number,
    sampleRows: readonly string[][],
): Set<number> {
    const numeric = new Set<number>();
    for (let col = 0; col < headerCount; col++) {
        let numericCount = 0;
        let nonEmptyCount = 0;
        for (const row of sampleRows) {
            const val = row[col]?.trim() ?? "";
            if (val === "") continue;
            nonEmptyCount++;
            if (isNumericString(val)) numericCount++;
        }
        if (
            nonEmptyCount > 0 &&
            numericCount / nonEmptyCount > NUMERIC_CLASSIFICATION_THRESHOLD
        ) {
            numeric.add(col);
        }
    }
    return numeric;
}

function rowToObject(
    headers: readonly string[],
    row: readonly string[],
    numericColumns: ReadonlySet<number>,
): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < headers.length; i++) {
        const raw = row[i] ?? "";
        if (numericColumns.has(i) && raw !== "") {
            const num = Number(raw);
            obj[headers[i]] = Number.isFinite(num) ? num : raw;
        } else {
            obj[headers[i]] = raw;
        }
    }
    return obj;
}

/**
 * Encapsulates row-pipeline state. Using a class instead of free
 * variables + a closure gives TypeScript clean field narrowing across
 * await boundaries.
 */
class RowPipeline {
    private headers: string[] | null = null;
    private numericColumns: Set<number> | null;
    private classified: boolean;
    private buffered: string[][] = [];

    constructor(
        private readonly autoCastNumbers: boolean,
        private readonly stripHeaderQuotes: boolean,
        private readonly sampleSize: number,
    ) {
        this.numericColumns = sampleSize === 0 ? new Set() : null;
        this.classified = sampleSize === 0;
    }

    /**
     * Feed a row through the pipeline. Returns ready-to-emit objects:
     *   - empty array  → row consumed for header or sampling
     *   - one element  → live row past the sample threshold
     *   - many         → sample threshold reached on this row, draining
     *                     all buffered rows + this one
     */
    accept(row: string[]): Record<string, unknown>[] {
        if (this.headers === null) {
            this.headers = this.stripHeaderQuotes
                ? row.map((h) => h.replace(/^"|"$/g, "").trim())
                : row;
            return [];
        }
        if (!this.classified) {
            this.buffered.push(row);
            if (this.buffered.length >= this.sampleSize) {
                this.classify();
                return this.drainBuffered();
            }
            return [];
        }
        const cols = this.numericColumns ?? new Set<number>();
        return [rowToObject(this.headers, row, cols)];
    }

    /**
     * Called once after the upstream stream closes. Emits any rows still
     * sitting in the sample buffer (the stream ended before we reached
     * the classification threshold).
     */
    flush(): Record<string, unknown>[] {
        if (this.headers === null) return [];
        if (!this.classified) this.classify();
        return this.drainBuffered();
    }

    private classify(): void {
        const headers = this.headers;
        if (headers === null) return;
        this.numericColumns = this.autoCastNumbers
            ? classifyNumericColumns(headers.length, this.buffered)
            : new Set();
        this.classified = true;
    }

    private drainBuffered(): Record<string, unknown>[] {
        const headers = this.headers;
        if (headers === null) return [];
        const cols = this.numericColumns ?? new Set<number>();
        const out = this.buffered.map((r) => rowToObject(headers, r, cols));
        this.buffered = [];
        return out;
    }
}

/**
 * Yields one row per gene/record in a streamed CSV. The first
 * {@link CsvStreamOptions.numericDetectionSampleSize} rows are buffered
 * for numeric column classification, then emitted in order alongside the
 * remainder of the stream.
 */
export async function* csvStream(
    stream: ReadableStream<Uint8Array>,
    options: CsvStreamOptions = {},
): AsyncGenerator<Record<string, unknown>, void, unknown> {
    const {
        autoCastNumbers = true,
        stripHeaderQuotes = false,
        numericDetectionSampleSize = DEFAULT_NUMERIC_SAMPLE_SIZE,
    } = options;
    const sampleSize = autoCastNumbers ? numericDetectionSampleSize : 0;

    const decoder = new TextDecoder("utf-8", { fatal: false });
    const reader = stream.getReader();
    const state = newParserState();
    const pipeline = new RowPipeline(
        autoCastNumbers,
        stripHeaderQuotes,
        sampleSize,
    );

    const ready: Record<string, unknown>[] = [];
    const enqueue = (row: string[]) => {
        for (const obj of pipeline.accept(row)) ready.push(obj);
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        feedChunk(state, text, enqueue);
        while (ready.length > 0) {
            yield ready.shift() as Record<string, unknown>;
        }
    }

    const tail = decoder.decode();
    if (tail.length > 0) feedChunk(state, tail, enqueue);
    finalizeState(state, enqueue);
    for (const obj of pipeline.flush()) ready.push(obj);

    while (ready.length > 0) {
        yield ready.shift() as Record<string, unknown>;
    }
}
