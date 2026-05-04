/**
 * Co-located smoke tests for the streaming CSV parser.
 *
 * The exhaustive suite (chunk-boundary correctness inside quoted fields,
 * UTF-8 splits, CRLF splits, numeric classification with buffered prefix,
 * many-row pressure, byte-for-byte parity with parseCsv) lives at:
 *
 *   tests/csv-stream.test.ts
 */
import { describe, expect, it } from "vitest";
import * as csvStreamModule from "./csv-stream";

const { csvStream } = csvStreamModule;

const enc = new TextEncoder();

function streamFromString(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(enc.encode(text));
            controller.close();
        },
    });
}

describe("csvStream (smoke)", () => {
    it("yields one row per data line, casting numerics by default", async () => {
        const out: Record<string, unknown>[] = [];
        for await (const r of csvStream(streamFromString("a,b\n1,foo\n"))) {
            out.push(r);
        }
        expect(out).toEqual([{ a: 1, b: "foo" }]);
    });
});
