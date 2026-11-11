import { canonicalJson, sha256Hex } from "../provenance/provenance";
import type { SavedQuery } from "./types";

type Runner = (query: SavedQuery) => Promise<unknown>;
const MAX_BYTES = 4 * 1024 * 1024;
// Keep even escaped control characters below the whole-response 30 KiB staging threshold.
const SLICE = 1500;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function complete(value: unknown): Record<string, unknown> {
  const result = object(value);
  const meta = object(result?._meta);
  const completeness = object(meta?.completeness);
  if (result?.success !== true || result.isError || result.error || result.program_error || result.disposition === "partial" ||
      meta?.program_did_not_complete || meta?.truncated === true || completeness?.truncated === true || completeness?.complete === false) {
    throw new Error("monitor: incomplete source result; retaining prior snapshot");
  }
  return result;
}

/** Read the lossless payloads row, never a materialized preview or an inferred table. */
export async function recoverStagedPayload(result: unknown, server: string, queryTool: string, run?: Runner): Promise<unknown> {
  const envelope = complete(result);
  const stage = object(envelope._staging);
  const data = object(envelope.data);
  if (!stage && !data?.__staged && !envelope.staged) return envelope.data;
  const meta = object(envelope._meta);
  const id = stage?.data_access_id;
  const hash = stage?.payload_hash;
  const wrapped = envelope.staged === true && envelope.data == null && envelope.data_access_id === id;
  const direct = data?.__staged === true && data.data_access_id === id;
  if (!run || !stage || (!direct && !wrapped) || typeof id !== "string" || !id ||
      (meta?.data_access_id != null && meta.data_access_id !== id) ||
      typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash) ||
      (meta?.payload_hash != null && meta.payload_hash !== hash)) {
    throw new Error("monitor: missing or conflicting staged evidence identity");
  }
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error("monitor: staged evidence read timed out")); }, 45_000);
  });
  let calls = 0;
  const query = async (sql: string) => {
    if (expired || ++calls > 3500) throw new Error("monitor: staged evidence read budget exceeded");
    const response = complete(await run({ server, tool: queryTool, params: { data_access_id: id, sql, limit: 1 } }));
    if (expired) throw new Error("monitor: staged evidence read timed out");
    const value = object(response.data);
    const completeness = object(object(response._meta)?.completeness);
    if (response._staging || response.staged || value?.__staged || value?.data_access_id !== id ||
        completeness?.count_capped || value?.count_capped || value?.truncated || value?.row_count !== 1 ||
        !Array.isArray(value.rows) || value.rows.length !== 1 || !object(value.rows[0])) {
      throw new Error("monitor: incomplete staged evidence query");
    }
    return value.rows[0] as Record<string, unknown>;
  };
  try {
    return await Promise.race([readVerifiedPayload(query, hash, wrapped), timeout]);
  } finally { expired = true; clearTimeout(timer); }
}

type Query = (sql: string) => Promise<Record<string, unknown>>;

async function readVerifiedPayload(query: Query, hash: string, wrapped: boolean): Promise<unknown> {
  const encoded = await readStoredPayload(query);
  let payload: unknown = JSON.parse(encoded);
  if (typeof payload === "string") payload = JSON.parse(payload);
  if (`sha256:${await sha256Hex(canonicalJson(payload))}` !== hash) throw new Error("monitor: staged payload hash mismatch");
  if (wrapped) {
    const nativeEnvelope = object(payload);
    if (nativeEnvelope?.isError || !Array.isArray(nativeEnvelope?.content)) throw new Error("monitor: invalid staged MCP envelope");
    const structured = complete(nativeEnvelope.structuredContent);
    if (structured._staging || structured.staged || object(structured.data)?.__staged) throw new Error("monitor: nested staged envelope is not a complete source result");
    return structured.data;
  }
  return payload;
}

function positiveSize(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("monitor: invalid staged evidence size");
  return value;
}

async function readSlices(query: Query, column: string, from: string, length: number): Promise<string> {
  let value = "";
  let size = 0;
  for (let offset = 1; offset <= length; offset += SLICE) {
    const row = await query(`SELECT substr(${column}, ${offset}, ${SLICE}) AS part FROM ${from}`);
    if (typeof row.part !== "string" || [...row.part].length !== Math.min(SLICE, length - offset + 1)) throw new Error("monitor: missing staged evidence slice");
    size += bytes(row.part);
    if (size > MAX_BYTES) throw new Error("monitor: staged payload exceeds 4 MiB");
    value += row.part;
  }
  return value;
}

async function readStoredPayload(query: Query): Promise<string> {
  const root = await query("SELECT length(root_json) AS length, substr(root_json, 1, 64) AS prefix FROM payloads WHERE id = 1");
  const length = positiveSize(root.length, MAX_BYTES);
  if (typeof root.prefix !== "string") throw new Error("monitor: missing staged payload root");
  if (!root.prefix.startsWith("__CHUNKED__:")) return readSlices(query, "root_json", "payloads WHERE id = 1", length);
  if (length !== root.prefix.length || !/^__CHUNKED__:chunk_[a-f0-9]{32}$/.test(root.prefix)) throw new Error("monitor: invalid staged chunk reference");
  const id = root.prefix.slice("__CHUNKED__:".length);
  const metadata = await query(`SELECT total_chunks, original_size, content_type, compressed FROM chunk_metadata WHERE content_id = '${id}'`);
  const count = positiveSize(metadata.total_chunks, 256);
  const originalSize = positiveSize(metadata.original_size, MAX_BYTES);
  if (metadata.content_type !== "json" || metadata.compressed !== 0) throw new Error("monitor: unsupported staged content encoding");
  let encoded = "";
  let size = 0;
  for (let index = 0; index < count; index++) {
    const from = `content_chunks WHERE content_id = '${id}' AND chunk_index = ${index}`;
    const row = await query(`SELECT length(chunk_data) AS length, chunk_size FROM ${from}`);
    const part = await readSlices(query, "chunk_data", from, positiveSize(row.length, 16384));
    if (part.length !== row.chunk_size) throw new Error("monitor: staged chunk length mismatch");
    size += bytes(part);
    if (size > MAX_BYTES) throw new Error("monitor: staged payload exceeds 4 MiB");
    encoded += part;
  }
  if (encoded.length !== originalSize) throw new Error("monitor: incomplete staged payload");
  return encoded;
}
