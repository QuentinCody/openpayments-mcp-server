import { expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../provenance/provenance";
import { runOnce } from "../run-once";
import { gtexSchema } from "./gtex-schema";

const document = () => ({ openapi: "3.1.0", info: { title: "GTEx Portal API", version: "2.0.0" },
  paths: { "/api/v2/association/egene": { get: { parameters: [{ name: "datasetId", schema: { default: "gtex_v8" } }] } } },
  components: { schemas: { DatasetId: { enum: ["gtex_v8", "gtex_v10"] } }, responses: {} }, "x-literal": "A | B",
});
async function envelope<T>(native: T) { return { success: true, data: { document: native, _schema: {
  source_url: "https://gtexportal.org/api/v2/openapi.json", http_status: 200, retrieved_at: "2026-10-02T00:00:00Z",
  parsed_response_sha256: await sha256Hex(canonicalJson(native)),
} } }; }
const tick = async (native: unknown, prior?: Awaited<ReturnType<typeof runOnce>>) => runOnce({ source: gtexSchema, input: {},
  run: async () => envelope(native), priorRowSets: prior?.rowSets, priorContentHash: prior?.contentHash });

it("detects definition changes while the API version stays constant, retaining native before/after", async () => {
  const before = await tick(document());
  const next = document(); next.paths["/api/v2/association/egene"].get.parameters[0].schema.default = "gtex_v10";
  const after = await tick(next, before);
  expect(after.query).toEqual({ server: "gtex", tool: "gtex_execute", params: { code: 'return await api.get("/discovery/openapi");' } });
  expect(after.changes).toHaveLength(1);
  expect(after.changes[0]).toMatchObject({ table: "schema", key: "/paths/~1api~1v2~1association~1egene", kind: "changed", materiality: "info",
    before: { value: { native: document().paths["/api/v2/association/egene"] } }, after: { value: { native: next.paths["/api/v2/association/egene"] } } });
});

it("detects additions/removals and preserves root extensions, arrays and empty containers", async () => {
  const original = document();
  const baseline = await tick(original);
  const changed = { ...original, paths: { "/api/v2/new": {} }, "x-literal": "B | A" };
  const after = await tick(changed, baseline);
  expect(after.changes.map(change => [change.kind, change.key]).sort()).toEqual([
    ["added", "/paths/~1api~1v2~1new"], ["changed", "/x-literal"], ["removed", "/paths/~1api~1v2~1association~1egene"],
  ]);
  const reconstructed: Record<string, any> = {};
  for (const row of baseline.rowSets[0].rows) {
    const parts = String(row.pointer).slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let cursor = reconstructed;
    for (const part of parts.slice(0, -1)) cursor = cursor[part];
    Object.defineProperty(cursor, parts.at(-1)!, { value: structuredClone((row.value as { native: unknown }).native), enumerable: true, writable: true, configurable: true });
  }
  expect(reconstructed).toEqual(original);
});

it("ignores object order, timestamps and citation churn", async () => {
  const first = await tick(document());
  const response = await envelope(JSON.parse(JSON.stringify(document())));
  response.data._schema.retrieved_at = "2026-10-03T00:00:00Z";
  const second = await runOnce({ source: gtexSchema, input: {}, run: async () => ({ ...response, _meta: { citation: "changed" } }), priorRowSets: first.rowSets, priorContentHash: first.contentHash });
  expect(second.unchanged).toBe(true); expect(second.changes).toEqual([]);
});

it.each([
  { paths: {} }, { openapi: "2.0" }, { components: [] }, { info: { title: "Other", version: "2" } },
  { paths: { "/large": { description: "a".repeat(65536) } } },
])("rejects invalid or oversized native schemas", async change => {
  await expect(tick({ ...document(), ...change })).rejects.toThrow("monitor:");
});

it("rejects a forged native hash", async () => {
  const response = await envelope(document()); response.data.document.info.version = "forged";
  await expect(runOnce({ source: gtexSchema, input: {}, run: async () => response })).rejects.toThrow("unrecognized GTEx schema");
});
