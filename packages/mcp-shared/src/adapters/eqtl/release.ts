export const releases = {
  default_release: "r7",
  releases: [
    { release: "r7", status: "released", assembly: "GRCh38", format: "bgzip/tabix", metadata_url: "https://raw.githubusercontent.com/eQTL-Catalogue/eQTL-Catalogue-resources/master/data_tables/dataset_metadata_r7.tsv" },
    { release: "r8_beta", status: "pre-release", assembly: "GRCh38", format: "Parquet", metadata_url: "https://raw.githubusercontent.com/eQTL-Catalogue/eQTL-Catalogue-resources/master/data_tables/dataset_metadata_r8_beta.tsv", files_url: "https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/", merged_credible_sets: "https://zenodo.org/records/22846842", final_release_schedule: "December 2026 (scheduled, not released)", notes: "Mutable pre-release; dataset IDs can be reused from r7 with different analyses. Pin metadata_sha256 and file_sha256 for reproducibility. Parquet queries require a configured local-file query service." },
  ],
};

export function eqtlError(message: string, status = 400, data?: unknown): never {
  const error = new Error(`eQTL Catalogue: ${message}`) as Error & { status: number; data: unknown };
  error.status = status;
  error.data = data ?? { source: "eqtl", status, message };
  throw error;
}

export function selectRelease(params?: Record<string, unknown>): "r7" | "r8_beta" {
  const release = params?.release === undefined ? "r7" : params.release;
  if (release !== "r7" && release !== "r8_beta") eqtlError("release must be r7 or r8_beta; final r8 is not available here");
  return release;
}

export async function beforeDeadline<T>(operation: Promise<T>, deadlineAt: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { eqtlError("response body exceeded its deadline", 504); } catch (error) { reject(error); }
      }, Math.max(0, deadlineAt - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

export async function boundedText(response: Response, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let size = 0;
  let text = "";
  const deadlineAt = Date.now() + 25_000;
  try {
    while (true) {
      const { done, value } = await beforeDeadline(reader.read(), deadlineAt);
      if (done) {
        text += decoder.decode();
        if (response.status === 206 || response.headers.has("content-range")) eqtlError("unexpected partial text response", 502,
          { response: text, http_status: response.status, content_range: response.headers.get("content-range") });
        return text;
      }
      size += value.byteLength;
      if (size > maxBytes) eqtlError(`response exceeds ${maxBytes} bytes`, 502);
      text += decoder.decode(value, { stream: true });
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

export function hashParam(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) eqtlError(`${name} must be a lowercase SHA-256`);
  return value;
}
