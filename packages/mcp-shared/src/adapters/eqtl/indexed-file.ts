import { BGZF_MAX_BLOCK_SIZE, inflateBgzf } from "./bgzf";
import { readFileEvidence } from "./file-evidence";
import { ebiFileFetch } from "./http";
import { parseTabixIndex } from "./tabix";

async function fetchIndex(url: string, fetchFile: typeof ebiFileFetch) {
  const response = await fetchFile(url, { cacheTtlSeconds: 86_400, timeout: 30_000, deadlineMs: 60_000 });
  const { bytes, evidence } = await readFileEvidence(response, url, 8 * 1024 * 1024);
  return { index: parseTabixIndex(await inflateBgzf(bytes)), evidence };
}

async function fetchHeader(url: string, fetchFile: typeof ebiFileFetch) {
  const range = { start: 0, end: BGZF_MAX_BLOCK_SIZE - 1 };
  const response = await fetchFile(url, { range });
  const { bytes, evidence } = await readFileEvidence(response, url, BGZF_MAX_BLOCK_SIZE, range);
  const first = await inflateBgzf(bytes, { maxBlocks: 1 });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(first);
  const newline = text.indexOf("\n");
  if (newline === -1) throw new Error("eQTL Catalogue: header exceeds the first BGZF block");
  const line = text.slice(0, newline).replace(/\r$/, "");
  const columns = line.replace(/^#/, "").split("\t");
  if (columns.length < 2 || columns.some(column => !column) || new Set(columns).size !== columns.length) {
    throw new Error(`eQTL Catalogue: invalid or duplicate header columns in ${url}`);
  }
  return { columns, line, evidence };
}

export function createIndexedFileReader(fetchFile: typeof ebiFileFetch = ebiFileFetch) {
  const indexes = new Map<string, ReturnType<typeof fetchIndex>>();
  const headers = new Map<string, ReturnType<typeof fetchHeader>>();

  // Bounded per-isolate caches preserve evidence with the bytes they describe.
  function loadIndexEvidence(url: string) {
    let result = indexes.get(url);
    if (!result) {
      if (indexes.size >= 4) indexes.clear();
      result = fetchIndex(url, fetchFile).catch(error => { indexes.delete(url); throw error; });
      indexes.set(url, result);
    }
    return result;
  }

  function loadHeaderEvidence(url: string) {
    let result = headers.get(url);
    if (!result) {
      if (headers.size >= 4) headers.clear();
      result = fetchHeader(url, fetchFile).catch(error => { headers.delete(url); throw error; });
      headers.set(url, result);
    }
    return result;
  }
  return { loadIndexEvidence, loadHeaderEvidence, resetFileCaches: () => { indexes.clear(); headers.clear(); } };
}

export const { loadIndexEvidence, loadHeaderEvidence, resetFileCaches } = createIndexedFileReader();

export async function loadTabixIndex(url: string) { return (await loadIndexEvidence(url)).index; }
export async function loadHeaderColumns(url: string) { return (await loadHeaderEvidence(url)).columns; }
