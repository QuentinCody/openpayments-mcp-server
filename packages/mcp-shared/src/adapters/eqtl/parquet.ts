import { parquetJson } from "./parquet-http";
import { validateParquetResult } from "./parquet-result";
import { eqtlError, hashParam } from "./release";

export interface ParquetRoute { kind: string; datasetId?: string }

function integer(value: unknown, name: string, min: number, max: number): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") eqtlError(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) eqtlError(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

export interface ParquetEnv {
  EQTL_PARQUET_URL?: string;
  EQTL_PARQUET_TOKEN?: string;
}

export function parquetRequest(route: ParquetRoute, params: Record<string, unknown>) {
  if (typeof route.datasetId !== "string" || !/^QTD\d{6}$/.test(route.datasetId)) eqtlError("invalid dataset ID");
  const metadataHash = hashParam(params.metadata_sha256, "metadata_sha256");
  const fileHash = hashParam(params.file_sha256, "file_sha256");
  if (!metadataHash || !fileHash) eqtlError("Parquet queries require metadata_sha256 and file_sha256 from an imported snapshot");
  const role = route.kind === "top-associations" ? "permuted" : route.kind === "credible-sets" ? "credible_sets" : params.file_role;
  if (!["all", "cc", "permuted", "credible_sets", "lbf_variable"].includes(String(role))) eqtlError("file_role must select an imported Parquet file: all, cc, permuted, credible_sets, or lbf_variable");
  if (params.file_role !== undefined && params.file_role !== role) eqtlError("file_role conflicts with the route");
  if (route.kind === "region" && role !== "all" && role !== "cc") eqtlError("region requires file_role all or cc");
  const filters: { column: string; op: string; value: string | number; }[] = buildParquetFilters(params, route);
  return { release: "r8_beta", dataset_id: route.datasetId, file_role: role, metadata_sha256: metadataHash, file_sha256: fileHash,
    operation: route.kind === "parquet-schema" ? "schema" : "query", filters, max_rows: integer(params.max_rows ?? 500, "max_rows", 1, 5000) };
}

function buildParquetFilters(params: Record<string, unknown>, route: ParquetRoute) {
  const filters: { column: string; op: string; value: string | number; }[] = [];
  const equality = ["gene_id", "molecular_trait_id", "molecular_trait_object_id", "rsid", "variant", "ref", "alt", "type", "cs_id", "chromosome", "position"];
  const controls = ["release", "metadata_sha256", "file_sha256", "file_role", "max_rows", "start", "end", "min_pip", "p_beta_max"];
  for (const key of Object.keys(params)) if (![...controls, ...equality].includes(key)) eqtlError(`unsupported Parquet parameter ${key}`);
  for (const key of equality) {
    const value = params[key];
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number") eqtlError(`${key} must be a string or number`);
    if (typeof value === "number" && !Number.isFinite(value)) eqtlError(`${key} must be finite`);
    filters.push({ column: key, op: "eq", value });
  }
  for (const [name, column, op] of [["min_pip", "pip", "ge"], ["p_beta_max", "p_beta", "le"]]) {
    if (params[name] === undefined) continue;
    const value = Number(params[name]);
    if (!["string", "number"].includes(typeof params[name]) || String(params[name]).trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) eqtlError(`${name} must be in [0, 1]`);
    filters.push({ column, op, value });
  }
  if (route.kind === "region") {
    if (typeof params.chromosome !== "string" || !params.chromosome) eqtlError("region requires chromosome using the exact file value (inspect parquet_schema)");
    const start = integer(params.start, "start", 1, Number.MAX_SAFE_INTEGER);
    const end = integer(params.end, "end", start, start + 5000000 - 1);
    filters.push({ column: "position", op: "ge", value: start }, { column: "position", op: "le", value: end });
  } else if (params.start !== undefined || params.end !== undefined) eqtlError("start/end are only valid for region");
  if (route.kind === "parquet-schema" && filters.length) eqtlError("parquet_schema does not accept row filters");
  return filters;
}

export async function queryParquet(route: ParquetRoute, params: Record<string, unknown>, env: ParquetEnv) {
  const request = parquetRequest(route, params);
  if (!env.EQTL_PARQUET_URL || !env.EQTL_PARQUET_TOKEN) eqtlError("Parquet query service is not configured; use /files for published bulk assets. Configure EQTL_PARQUET_URL and EQTL_PARQUET_TOKEN after importing a checksum-verified snapshot.", 503);
  let url: URL;
  try { url = new URL(env.EQTL_PARQUET_URL); } catch { eqtlError("invalid Parquet service configuration", 503); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) eqtlError("invalid Parquet service configuration", 503);
  return validateParquetResult(await parquetJson(url.href, env.EQTL_PARQUET_TOKEN, request), request);
}
