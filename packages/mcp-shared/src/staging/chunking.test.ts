import { describe, expect, it } from "vitest";
import { ChunkingEngine, type SqlExec } from "./chunking";

// Stateful SQL fake: records content_chunks inserts, replays them on the
// ordered SELECT. CREATE/INDEX/metadata statements are no-ops.
const makeSql = () => {
	const chunks: Array<{ content_id: string; chunk_index: number; chunk_data: string }> = [];
	const sql: SqlExec = {
		exec: (query: string, ...b: unknown[]) => {
			if (query.includes("INSERT INTO content_chunks")) {
				chunks.push({ content_id: b[0] as string, chunk_index: b[1] as number, chunk_data: b[2] as string });
			}
			return {
				toArray: () => {
					if (query.includes("SELECT chunk_data FROM content_chunks")) {
						return chunks
							.filter((c) => c.content_id === b[0])
							.sort((x, y) => x.chunk_index - y.chunk_index)
							.map((c) => ({ chunk_data: c.chunk_data }));
					}
					return [];
				},
			};
		},
	};
	return { sql, chunks };
};

const engine = () => new ChunkingEngine();

describe("ChunkingEngine reference helpers", () => {
	it("detects whether content should be chunked (>32KB)", () => {
		const e = engine();
		expect(e.shouldChunk("x".repeat(1000))).toBe(false);
		expect(e.shouldChunk("x".repeat(33 * 1024))).toBe(true);
	});

	it("recognizes and round-trips content references", () => {
		const e = engine();
		expect(e.isContentReference("__CHUNKED__:abc")).toBe(true);
		expect(e.isContentReference("plain")).toBe(false);
		expect(e.isContentReference(42)).toBe(false);
		const ref = e.createContentReference({
			contentId: "abc",
			totalChunks: 1,
			originalSize: 1,
			contentType: "json",
			compressed: false,
		});
		expect(ref).toBe("__CHUNKED__:abc");
		expect(e.extractContentId(ref)).toBe("abc");
	});
});

describe("smartJsonStringify / smartJsonParse", () => {
	it("passes small JSON through without chunking", async () => {
		const { sql, chunks } = makeSql();
		const e = engine();
		const out = await e.smartJsonStringify({ a: 1 }, sql);
		expect(out).toBe('{"a":1}');
		expect(chunks).toHaveLength(0);
	});

	it("chunks large JSON and round-trips it back through parse", async () => {
		const { sql, chunks } = makeSql();
		const e = engine();
		const big = { data: "x".repeat(40 * 1024) };
		const ref = await e.smartJsonStringify(big, sql);
		expect(ref.startsWith("__CHUNKED__:chunk_")).toBe(true);
		expect(chunks.length).toBeGreaterThan(1); // split into 16KB chunks
		expect(await e.smartJsonParse(ref, sql)).toEqual(big);
	});

	it("parses a plain (non-reference) JSON string", async () => {
		const { sql } = makeSql();
		expect(await engine().smartJsonParse('{"b":2}', sql)).toEqual({ b: 2 });
	});

	it("throws on malformed non-reference JSON", async () => {
		const { sql } = makeSql();
		await expect(engine().smartJsonParse("not json{", sql)).rejects.toThrow(/Failed to parse JSON value/);
	});

	it("throws when a referenced content id is missing", async () => {
		const { sql } = makeSql();
		await expect(engine().smartJsonParse("__CHUNKED__:nope", sql)).rejects.toThrow(/Missing chunked content nope/);
	});

	it("throws when stored chunked content is not valid JSON", async () => {
		const { sql } = makeSql();
		const e = engine();
		const meta = await e.storeChunkedContent("not json {", "text", sql);
		await expect(e.smartJsonParse(e.createContentReference(meta), sql)).rejects.toThrow(
			/Failed to parse stored chunked content/,
		);
	});
});

describe("storeChunkedContent / retrieveChunkedContent", () => {
	it("stores metadata + ordered chunks and reassembles them", async () => {
		const { sql } = makeSql();
		const e = engine();
		const content = "y".repeat(40 * 1024);
		const meta = await e.storeChunkedContent(content, "json", sql);
		expect(meta).toMatchObject({ contentType: "json", originalSize: content.length, compressed: false });
		expect(meta.totalChunks).toBeGreaterThan(1);
		expect(meta.contentId).toMatch(/^chunk_/);
		expect(await e.retrieveChunkedContent(meta.contentId, sql)).toBe(content);
	});

	it("returns null when no chunks exist for an id", async () => {
		const { sql } = makeSql();
		expect(await engine().retrieveChunkedContent("ghost", sql)).toBeNull();
	});
});
