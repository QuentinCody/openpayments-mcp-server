import { expandDkanParams } from "./http";
const ROOT = "https://openpaymentsdata.cms.gov";

function requestError(message: string, status: number, data?: unknown) {
  return Object.assign(new Error(message), { status,
    data: data ?? { error: { code: "OPENPAYMENTS_REQUEST_ERROR", message, status } },
  });
}

export function fail(message: string, status = 400, data?: unknown): never {
  throw requestError(message, status, data);
}

export function urlFor(path: string, params: Record<string, unknown>): URL {
  const url = new URL(`/api/1${path}`, ROOT);
  if (url.origin !== ROOT || url.username || url.password || url.hash) fail("Unsupported Open Payments URL");
  for (const [key, value] of Object.entries(expandDkanParams(params) ?? {})) {
    if (value === undefined) continue;
    if (!["string", "number", "boolean"].includes(typeof value) || String(value).length > 16000 || key.length > 200 || (typeof value === "number" && !Number.isFinite(value))) fail("Unsupported query value");
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function bodyJson(response: Response, sourceUrl: string, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) fail("Empty Open Payments response", 502);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) fail("Open Payments response exceeds byte limit; narrow the request", 502);
      chunks.push(decoder.decode(part.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const text = chunks.join("");
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok || !data || typeof data !== "object" || "error" in data || "errors" in data) {
      fail(response.ok ? "Invalid Open Payments JSON envelope" : `Open Payments HTTP ${response.status}`, response.ok ? 502 : response.status, {
        native_error: data, response_evidence: { source_url: sourceUrl, upstream_status: response.status,
          observed_at: new Date().toISOString(), response_sha256: await hash(data), complete: false,
          hash_scope: "Complete parsed native error body, or complete text when not JSON; recursively sorted object keys" },
      });
    }
    return data;
  } finally {
    void reader.cancel().catch(() => {}); // Best-effort cleanup after the read.
    reader.releaseLock();
  }
}

export async function readPaymentResponse(url: URL, deadline: number, maxBytes = 4 * 1024 * 1024): Promise<{ status: number; data: unknown }> {
  if (url.origin !== ROOT || url.username || url.password || url.hash) fail("Unsupported Open Payments URL");
  const remaining = deadline - Date.now();
  if (remaining <= 0) fail("Open Payments release read deadline exceeded", 504);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(requestError("Open Payments release read deadline exceeded", 504));
    }, remaining);
  });
  try {
    const work = async () => {
      const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "manual", signal: controller.signal });
      return { status: response.status, data: await bodyJson(response, url.href, maxBytes) };
    };
    return await Promise.race([work(), timeout]);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw requestError("Open Payments response unavailable or invalid JSON", 502);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function releaseRead(path: string, params: Record<string, unknown>, deadline: number, maxBytes = 4 * 1024 * 1024) {
  const url = urlFor(path, params);
  return { ...await readPaymentResponse(url, deadline, maxBytes), source_url: url.href };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    // SAFETY: own entries of this JSON object are indexed by sorted own keys.
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
  }
  return value;
}

export async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
