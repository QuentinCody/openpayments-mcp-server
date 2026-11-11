import type { parquetRequest } from "./parquet";
import { eqtlError } from "./release";

type Request = ReturnType<typeof parquetRequest>;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameFilters(value: unknown, expected: Request["filters"]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) =>
    record(item) && Object.keys(item).length === 3 && item.column === expected[index].column &&
    item.op === expected[index].op && item.value === expected[index].value);
}

export function validateParquetResult(value: unknown, request: Request): Record<string, unknown> {
  if (!record(value)) eqtlError("Parquet service returned an invalid result object", 502);
  const metadata = value.metadata;
  if (value.release !== request.release || value.dataset_id !== request.dataset_id || value.file_role !== request.file_role ||
    value.metadata_sha256 !== request.metadata_sha256 || value.file_sha256 !== request.file_sha256 || value.assembly !== "GRCh38" ||
    value.status !== "pre-release" || !record(metadata) || metadata.dataset_id !== request.dataset_id ||
    typeof metadata.study_id !== "string" || !/^QTS\d{6}$/.test(metadata.study_id)) {
    eqtlError("Parquet service returned mismatched snapshot provenance", 502);
  }
  const category = ["credible_sets", "lbf_variable"].includes(String(request.file_role)) ? "susie" : "sumstats";
  const source = `https://ftp.ebi.ac.uk/pub/databases/spot/eQTL/r8_beta/${category}/${metadata.study_id}/${request.dataset_id}/${request.dataset_id}.${request.file_role}.parquet`;
  if (value.source_url !== source) eqtlError("Parquet service returned mismatched source identity", 502);
  const schema = value.schema;
  if (!Array.isArray(schema) || !schema.length || !schema.every(field => record(field) && typeof field.name === "string" &&
    field.name.length > 0 && typeof field.type === "string" && field.type.length > 0 && typeof field.nullable === "boolean")) {
    eqtlError("Parquet service returned an invalid schema", 502);
  }
  const columns = new Set(schema.map(field => field.name));
  if (columns.size !== schema.length) eqtlError("Parquet service returned duplicate schema columns", 502);
  if (request.filters.some(filter => !columns.has(filter.column))) eqtlError("Parquet service schema omits a requested filter column", 502);
  validateQueryRows(request, value, columns);
  return value;
}

function validateQueryRows(request: Request, value: Record<string, unknown>, columns: Set<string>) {
  if (request.operation === "query") {
    const rows = value.rows;
    if (!Array.isArray(rows) || rows.length > request.max_rows || value.row_count !== rows.length || typeof value.truncated !== "boolean" ||
      !sameFilters(value.filters, request.filters) || value.total_matching_rows !== null ||
      !rows.every(row => record(row) && Object.keys(row).length === columns.size && Object.keys(row).every(key => columns.has(key)))) {
      eqtlError("Parquet service returned an invalid bounded result or query identity", 502);
    }
    if (value.truncated ? !["max_rows", "response_bytes"].includes(String(value.truncation_reason)) ||
      (value.truncation_reason === "max_rows" && rows.length !== request.max_rows) : value.truncation_reason !== null) {
      eqtlError("Parquet service returned inconsistent truncation evidence", 502);
    }
  }
}
