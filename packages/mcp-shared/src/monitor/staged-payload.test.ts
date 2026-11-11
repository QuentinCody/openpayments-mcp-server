import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ChunkingEngine } from "../staging/chunking";
import { canonicalJson, sha256Hex } from "../provenance/provenance";
import { recoverStagedPayload } from "./staged-payload";
import type { SavedQuery } from "./types";

afterEach(() => vi.useRealTimers());
async function fixture(payload: unknown) {
  const database = new DatabaseSync(":memory:");
  const sql = { exec: (query: string, ...values: any[]) => { const rows = database.prepare(query).all(...values); return { toArray: () => rows }; } };
  database.prepare("CREATE TABLE payloads (id INTEGER PRIMARY KEY, root_json TEXT)").run();
  const canonical = canonicalJson(payload);
  const stored = await new ChunkingEngine().smartJsonStringify(canonical, sql);
  database.prepare("INSERT INTO payloads VALUES (1, ?)").run(stored);
  const hash = `sha256:${await sha256Hex(canonical)}`;
  const result = { success: true, data: { __staged: true, data_access_id: "fixture" },
    _staging: { data_access_id: "fixture", payload_hash: hash }, _meta: { data_access_id: "fixture", payload_hash: hash } };
  const run = vi.fn(async (query: SavedQuery) => {
    expect(query.server).toBe("gtex"); expect(query.tool).toBe("gtex_query_data");
    expect(query.params.data_access_id).toBe("fixture"); expect(query.params.limit).toBe(1);
    const rows = database.prepare(String(query.params.sql)).all();
    return { success: true, data: { rows, row_count: rows.length, data_access_id: "fixture" } };
  });
  return { result, run, database };
}

it.each(["small", 'α 🧬 \\" | β'.repeat(15000)])("recovers complete native JSON from real staging storage", async text => {
  const payload = { document: { native: text }, _schema: { source_url: "fixture" } };
  const f = await fixture(payload);
  try {
    expect(await recoverStagedPayload(f.result, "gtex", "gtex_query_data", f.run)).toEqual(payload);
    expect(f.run.mock.calls.length).toBeGreaterThan(1);
  } finally { f.database.close(); }
});

it.each(["missing", "tampered", "bad-size", "bad-count", "compressed"])("rejects %s staged evidence", async mode => {
  const f = await fixture({ native: "α".repeat(40000) });
  try {
    if (mode === "missing") f.database.prepare("DELETE FROM content_chunks WHERE chunk_index = 1").run();
    if (mode === "tampered") f.database.prepare("UPDATE content_chunks SET chunk_data = replace(chunk_data, 'α', 'β')").run();
    if (mode === "bad-size") f.database.prepare("UPDATE chunk_metadata SET original_size = original_size - 1").run();
    if (mode === "bad-count") f.database.prepare("UPDATE chunk_metadata SET total_chunks = 257").run();
    if (mode === "compressed") f.database.prepare("UPDATE chunk_metadata SET compressed = 1").run();
    await expect(recoverStagedPayload(f.result, "gtex", "gtex_query_data", f.run)).rejects.toThrow(/monitor:/);
  } finally { f.database.close(); }
});

it("verifies and unwraps the complete MCP response staging form", async () => {
  const native = { document: { description: "α".repeat(20000) } };
  const f = await fixture({ content: [{ type: "text", text: "summary" }], structuredContent: { success: true, data: native } });
  try {
    const wrapper = { ...f.result, data: undefined, staged: true, data_access_id: "fixture" };
    expect(await recoverStagedPayload(wrapper, "gtex", "gtex_query_data", f.run)).toEqual(native);
  } finally { f.database.close(); }
});

it.each([
  { success: false }, { isError: true }, { disposition: "partial" }, { program_error: { code: "PROGRAM_DID_NOT_COMPLETE" } },
  { _meta: { completeness: { complete: false } } }, { data: { __staged: true, data_access_id: "wrong" } },
  { _staging: { data_access_id: "fixture", payload_hash: "wrong" } },
])("refuses incomplete/conflicting envelopes before SQL: %j", async change => {
  const f = await fixture({ native: "small" });
  try {
    await expect(recoverStagedPayload({ ...f.result, ...change }, "gtex", "gtex_query_data", f.run)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  } finally { f.database.close(); }
});

it("rejects a restaged/truncated SQL response", async () => {
  const f = await fixture({ native: "small" });
  try {
    f.run.mockResolvedValueOnce({ success: true, data: { rows: [], row_count: 0, data_access_id: "fixture" } });
    await expect(recoverStagedPayload(f.result, "gtex", "gtex_query_data", f.run)).rejects.toThrow("incomplete staged evidence query");
  } finally { f.database.close(); }
});

it.each(["restaged", "capped", "truncated"])("rejects %s SQL results even with a single apparent row", async mode => {
  const f = await fixture({ native: "small" });
  try {
    const run = async () => ({ success: true, ...(mode === "restaged" ? { _staging: {} } : {}),
      _meta: { truncated: mode === "truncated" }, data: { rows: [{ length: 20, prefix: "not authoritative" }], row_count: 1, data_access_id: "fixture", count_capped: mode === "capped" } });
    await expect(recoverStagedPayload(f.result, "gtex", "gtex_query_data", run)).rejects.toThrow("monitor:");
  } finally { f.database.close(); }
});

it("stops issuing SQL after the total deadline even if a delayed query resolves", async () => {
  vi.useFakeTimers();
  const f = await fixture({ native: "small" });
  let finish!: (value: unknown) => void;
  const run = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  try {
    const pending = expect(recoverStagedPayload(f.result, "gtex", "gtex_query_data", run)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(45_000); await pending;
    finish({ success: true, data: { rows: [{ length: 20 }], row_count: 1, data_access_id: "fixture" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  } finally { f.database.close(); }
});
