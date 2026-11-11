import { beforeDeadline, eqtlError } from "./release";

const MAX_BYTES = 2 * 1024 * 1024;

class ParquetResponseError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

function cancel(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readJson(response: Response, deadlineAt: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ParquetResponseError("Parquet service returned an empty response");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await beforeDeadline(reader.read(), deadlineAt);
      if (done) return JSON.parse(text + decoder.decode());
      size += value.byteLength;
      if (size > MAX_BYTES) throw new ParquetResponseError("Parquet service response exceeds 2 MiB");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** One deadline covers connection and body; backend bodies never enter errors. */
export async function parquetJson(url: string, token: string, request: unknown): Promise<unknown> {
  const body = JSON.stringify(request);
  if (new TextEncoder().encode(body).byteLength > 64 * 1024) eqtlError("Parquet request exceeds 64 KiB", 413);
  const controller = new AbortController();
  const deadlineAt = Date.now() + 35_000;
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const pending = fetch(url, { method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body });
    // A transport may resolve after abort. Dispose of that late body as well.
    void pending.then(response => { if (controller.signal.aborted) cancel(response); }, () => undefined);
    const response = await beforeDeadline(pending, deadlineAt);
    if (response.status !== 200) {
      cancel(response);
      throw new ParquetResponseError(`Parquet service returned HTTP ${response.status}; verify imported checksums, column names and filters with parquet_schema`,
        [400, 404, 409, 413, 503, 504].includes(response.status) ? response.status : 502);
    }
    if (response.headers.has("content-range") || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      cancel(response);
      throw new ParquetResponseError("Parquet service returned a partial or non-JSON response");
    }
    const data = await readJson(response, deadlineAt);
    if (JSON.stringify(data).includes(token)) throw new ParquetResponseError("Parquet service returned credential material");
    return data;
  } catch (error) {
    // Only locally constructed errors are safe; transport/parser messages may
    // contain backend text, local paths, request URLs or authentication data.
    if (error instanceof ParquetResponseError) eqtlError(error.message, error.status);
    eqtlError("Parquet service failed or exceeded its deadline", controller.signal.aborted || Date.now() >= deadlineAt ? 504 : 502);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
