import { beforeDeadline, eqtlError } from "./release";

export interface FileEvidence {
  source_url: string;
  retrieved_at: string;
  http_status: number;
  etag: string | null;
  last_modified: string | null;
  content_range: string | null;
  byte_length: number;
  sha256: string;
  hash_scope: "complete_response_bytes";
}

export interface RequestedRange { start: number; end: number }

function responseLength(response: Response, range?: RequestedRange): number | undefined {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) eqtlError("invalid Content-Length", 502);
  if (range) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (response.status !== 206 || !match) eqtlError("range request requires HTTP 206 and a numeric Content-Range", 502);
    const [start, end, total] = match.slice(1).map(Number);
    if (![start, end, total].every(Number.isSafeInteger) || start !== range.start ||
        end !== Math.min(range.end, total - 1) || end < start || total <= end) {
      eqtlError("Content-Range does not match the requested byte interval", 502);
    }
    const expected = end - start + 1;
    if (length !== null && Number(length) !== expected) eqtlError("Content-Length conflicts with Content-Range", 502);
    return expected;
  }
  if (response.status !== 200 || response.headers.has("content-range")) eqtlError("complete file request requires HTTP 200 without Content-Range", 502);
  if (length === null) return undefined;
  return Number(length);
}

/** Bound bytes before buffering; a full-file HTTP 200 must never satisfy a range read. */
export async function readFileEvidence(
  response: Response, sourceUrl: string, maxBytes: number, range?: RequestedRange,
): Promise<{ bytes: Uint8Array; evidence: FileEvidence }> {
  let expected: number | undefined;
  try {
    if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") {
      eqtlError("encoded HTTP bodies cannot establish compressed-file byte offsets", 502);
    }
    expected = responseLength(response, range);
    if (expected !== undefined && expected > maxBytes) eqtlError(`file response exceeds ${maxBytes} bytes; narrow the region`, 502);
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) eqtlError("file response body is missing", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadlineAt = Date.now() + 15_000;
  try {
    while (true) {
      const { done, value } = await beforeDeadline(reader.read(), deadlineAt);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes || (expected !== undefined && size > expected)) eqtlError("file body exceeds its byte limit or declared range", 502);
      chunks.push(value);
    }
    if (expected !== undefined && size !== expected) eqtlError("file body is shorter than its declared range or length", 502);
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return { bytes, evidence: {
    source_url: sourceUrl, retrieved_at: new Date().toISOString(), http_status: response.status,
    etag: response.headers.get("etag"), last_modified: response.headers.get("last-modified"),
    content_range: response.headers.get("content-range"), byte_length: size,
    sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join(""),
    hash_scope: "complete_response_bytes",
  } };
}

export function assertFileHash(evidence: FileEvidence, expected?: string): void {
  if (expected && expected !== evidence.sha256) eqtlError("file response hash changed; rediscover source evidence", 409);
}

export function assertSameFile(header: FileEvidence, range: FileEvidence): void {
  for (const field of ["etag", "last_modified"] as const) {
    if (header[field] && range[field] && header[field] !== range[field]) eqtlError("summary-statistics file changed between header and region reads", 409);
  }
}
