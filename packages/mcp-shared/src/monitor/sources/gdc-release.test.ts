import { afterEach, expect, it, vi } from "vitest";
import { restHandler } from "../../../../../servers/nci-gdc-mcp-server/src/rest/tool";
import { runOnce } from "../run-once";
import { gdcRelease } from "./gdc-release";

// Native field shape observed September 30; values here are explicit test fixtures.
const native = {
  status: "OK", tag: "8.5.0", version: 1, commit: "build-a",
  data_release: "Data Release 46.0 - August 10, 2026",
  data_release_version: { major: 46, minor: 0, release_date: "2026-08-10" },
  future: { retained: true },
};
function envelope(data: unknown = native) {
  return { success: true, data, _rest: { operation: "status", http_status: 200,
    source_url: "https://api.gdc.cancer.gov/status", retrieved_at: "2026-09-30", data_release_header: null },
    _meta: { citation: { result_hash: "fixture" } } };
}
const run = (result: unknown, prior?: Awaited<ReturnType<typeof runOnce>>) => runOnce({
  source: gdcRelease, input: {}, run: async () => result,
  priorContentHash: prior?.contentHash, priorRowSets: prior?.rowSets,
});
afterEach(() => vi.unstubAllGlobals());

it("uses the real GDC status handler and retains native evidence through the monitor pipeline", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json(native));
  vi.stubGlobal("fetch", fetcher);
  const query = gdcRelease.buildQuery({});
  expect(query).toEqual({ server: "nci-gdc", tool: "gdc_rest", params: { operation: "status", parameters: {} } });
  const response = await restHandler({ operation: "status", parameters: {} }, {});
  const result = await run(response.structuredContent);
  expect(result.cleaned).toMatchObject({ evidence: { data: native, _meta: expect.any(Object) },
    releases: [{ component: "api", version: { tag: "8.5.0", version: 1, commit: "build-a" } },
      { component: "data", version: { data_release_version: native.data_release_version } }] });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.gdc.cancer.gov/status");
});

it.each([
  [{ tag: "8.6.0" }, "api"], [{ commit: "build-b" }, "api"], [{ version: 2 }, "api"],
  [{ data_release: "Data Release 47.0" }, "data"],
  [{ data_release_version: { major: 47, minor: 0, release_date: "2026-10-01" } }, "data"],
])("separates API/build and data-release changes: %j", async (fields, component) => {
  const baseline = await run(envelope());
  const result = await run(envelope({ ...native, ...fields }), baseline);
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({ key: component, kind: "changed", materiality: "info" });
  expect(result.unchanged).toBe(false);
});

it("ignores retrieval/citation and unrelated field churn while retaining evidence", async () => {
  const baseline = await run(envelope());
  const next = envelope({ ...native, future: { retained: "changed" } });
  next._rest.retrieved_at = "2026-10-01";
  next._meta.citation.result_hash = "new-hash";
  const result = await run(next, baseline);
  expect(result.unchanged).toBe(true);
  expect(result.changes).toEqual([]);
  expect(result.cleaned).toMatchObject({ evidence: next });
});

it("keeps missing data-release fields unknown and detects metadata disappearance", async () => {
  const baseline = await run(envelope());
  const result = await run(envelope({ status: "OK", tag: "8.5.0", version: 1, commit: "build-a" }), baseline);
  expect(result.changes).toMatchObject([{ key: "data", after: { version: {
    data_release: null, data_release_version: null, data_release_header: null,
  } } }]);
});

it.each([
  null, { success: false }, { ...envelope(), staged: true }, { ...envelope(), _staging: {} },
  envelope({ __staged: true }), envelope({ ...native, status: "DOWN" }),
  envelope({ ...native, tag: "" }), envelope({ ...native, version: null }),
  { ...envelope(), _rest: { operation: "search", http_status: 200 } },
])("rejects incomplete/error responses instead of emitting removals: %j", async (response) => {
  await expect(run(response)).rejects.toThrow("retaining the prior snapshot");
});
