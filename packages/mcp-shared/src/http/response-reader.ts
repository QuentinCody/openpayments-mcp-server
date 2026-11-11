export interface ResponseReadOptions {
  label: string;
  maxBytes: number;
  /** Body-read budget; the fetch caller owns the header/request deadline. */
  timeoutMs: number;
}

/** Retain exact bytes while bounding even an uncooperative response stream. */
export async function readResponseBytes(response: Response, options: ResponseReadOptions): Promise<Uint8Array> {
  const fail = (message: string, status: number): never => { throw Object.assign(new Error(`${options.label} ${message}`), { status }); };
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !Number.isFinite(options.timeoutMs)) throw new RangeError("Invalid response read bounds");
  const reader = response.body?.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (options.timeoutMs <= 0) fail("response read timed out", 504);
    if (Number(response.headers.get("content-length")) > options.maxBytes) fail(`response exceeds ${options.maxBytes} bytes`, 413);
    if (!reader) return new Uint8Array();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${options.label} response read timed out`), { status: 504 })), options.timeoutMs);
    });
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > options.maxBytes) fail(`response exceeds ${options.maxBytes} bytes`, 413);
      chunks.push(part.value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

/** Keep a leading BOM in text evidence; JSON callers may remove it before parsing. */
export function decodeResponseText(bytes: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Object.assign(new Error(`${label} response is not valid UTF-8`), { status: 502 }); }
}
