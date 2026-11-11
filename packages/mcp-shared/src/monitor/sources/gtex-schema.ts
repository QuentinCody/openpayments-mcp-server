import { canonicalJson, sha256Hex } from "../../provenance/provenance";
import { object, recoverStagedPayload } from "../staged-payload";
import type { SourceModule } from "../types";

const SOURCE_URL = "https://gtexportal.org/api/v2/openapi.json";
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const pointer = (parts: string[]) => `/${parts.map(part => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;

/** Keep every native value exactly once, including empty containers and extension fields. */
function definitions(document: Record<string, unknown>) {
  const rows: Array<{ pointer: string; value: { native: unknown } }> = [];
  const add = (parts: string[], value: unknown) => {
    const row = { pointer: pointer(parts), value: { native: value } };
    if (size(row) > 64 * 1024) throw new Error("monitor: GTEx schema definition exceeds 64 KiB");
    rows.push(row);
  };
  for (const [key, value] of Object.entries(document)) {
    if ((key === "paths" || key === "components") && object(value)) {
      add([key], {});
      for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === "components" && object(item)) {
          add([key, name], {});
          for (const [definition, native] of Object.entries(item as Record<string, unknown>)) add([key, name, definition], native);
        } else add([key, name], item);
      }
    } else add([key], value);
  }
  if (rows.length > 5000 || size(rows) > 900_000) throw new Error("monitor: GTEx schema exceeds snapshot budget");
  return rows;
}

export const gtexSchema: SourceModule = {
  id: "gtex-schema",
  label: "GTEx — published OpenAPI definitions",
  profile: { tables: [{ table: "schema", path: "definitions", keyFields: ["pointer"], valueFields: ["value"] }] },
  buildQuery: () => ({ server: "gtex", tool: "gtex_execute", params: { code: 'return await api.get("/discovery/openapi");' } }),
  prepareResult: async (result, run) => {
    const payload = object(await recoverStagedPayload(result, "gtex", "gtex_query_data", run));
    const document = object(payload?.document);
    const context = object(payload?._schema);
    const info = object(document?.info);
    const paths = object(document?.paths);
    if (!document || !/^3\.[01]\.\d+$/.test(String(document.openapi)) || info?.title !== "GTEx Portal API" ||
        typeof info.version !== "string" || !info.version.trim() || !paths || !Object.keys(paths).length ||
        Object.entries(paths).some(([path, value]) => path.startsWith("/") ? !object(value) : !path.startsWith("x-")) ||
        (document.components != null && !object(document.components)) ||
        context?.source_url !== SOURCE_URL || context.http_status !== 200 ||
        typeof context.retrieved_at !== "string" || !Number.isFinite(Date.parse(context.retrieved_at)) ||
        context.parsed_response_sha256 !== await sha256Hex(canonicalJson(document))) {
      throw new Error("monitor: incomplete, failed or unrecognized GTEx schema; retaining prior snapshot");
    }
    return {
      definitions: definitions(document),
      evidence: { ...context, citation: object(object(result)?._meta)?.citation },
    };
  },
  classify: (change) => ({ materiality: "info", label: `GTEx published schema ${change.kind}: ${change.key}; review client compatibility (not a runtime or dataset-release assertion)` }),
};
