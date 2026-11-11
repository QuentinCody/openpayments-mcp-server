import { afterEach, expect, it, vi } from "vitest";
import { createUniProtApiFetch } from "../../../../../servers/uniprot-mcp-server/src/lib/api-adapter";
import { runOnce } from "../run-once";
import { uniprotRelease } from "./uniprot-release";

// Explicit fixtures, not assertions about the currently deployed provider release.
const sourceUrl = "https://rest.uniprot.org/uniprotkb/search?query=accession%3AP69905&fields=accession&format=json&size=1";
function envelope(release: unknown = "2026_01", releaseDate: unknown = "01-Feb-2026") {
  return { success: true, data: { results: [{ primaryAccession: "P69905" }],
    _uniprot: { source_url: sourceUrl, release, release_date: releaseDate, retrieved_at: "2026-10-01" },
    future: { retained: true },
  }, _meta: { citation: { result_hash: "fixture" } } };
}
const run = (result: unknown, prior?: Awaited<ReturnType<typeof runOnce>>) => runOnce({
  source: uniprotRelease, input: {}, run: async () => result,
  priorContentHash: prior?.contentHash, priorRowSets: prior?.rowSets,
});
afterEach(() => vi.unstubAllGlobals());

it("runs the saved Code Mode recipe through the existing UniProt adapter", async () => {
  const fetcher = vi.fn(async () => Response.json({ results: [{ primaryAccession: "P69905" }], future: "native" }, {
    headers: { "X-UniProt-Release": "2026_01", "X-UniProt-Release-Date": "01-Feb-2026" },
  }));
  vi.stubGlobal("fetch", fetcher);
  const query = uniprotRelease.buildQuery({});
  expect(query).toMatchObject({ server: "uniprot", tool: "uniprot_api_execute" });
  const execute = new Function("api", `return (async () => {${query.params.code}})()`);
  const apiFetch = createUniProtApiFetch();
  const native = await execute({ get: async (path: string, params: Record<string, unknown>) =>
    (await apiFetch({ method: "GET", path, params })).data });
  const result = await run({ success: true, data: native });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith(sourceUrl, expect.objectContaining({ method: "GET" }));
  expect(result.cleaned).toMatchObject({ evidence: { data: { future: "native", _uniprot: { source_url: sourceUrl } } },
    releases: [{ component: "uniprotkb", version: { release: "2026_01", release_date: "01-Feb-2026" } }] });
  expect(result.changes).toEqual([]);
});

it.each([
  ["2026_02", "01-Feb-2026"], ["2026_01", "02-Feb-2026"], ["2026_01", null],
])("detects release metadata changes without a protein-change claim: %s %s", async (release, date) => {
  const baseline = await run(envelope());
  const changed = await run(envelope(release, date), baseline);
  expect(changed.unchanged).toBe(false);
  expect(changed.changes).toMatchObject([{ key: "uniprotkb", kind: "changed", materiality: "info",
    after: { version: { release, release_date: date } }, label: expect.stringContaining("not an archived release pin") }]);
});

it("retains evidence but ignores entry, timestamp and citation churn", async () => {
  const baseline = await run(envelope());
  const next = envelope();
  next.data._uniprot.retrieved_at = "2026-10-02";
  next._meta.citation.result_hash = "changed";
  next.data.future.retained = false;
  const result = await run(next, baseline);
  expect(result.cleaned).toMatchObject({ evidence: next });
  expect(result.unchanged).toBe(true);
  expect(result.changes).toEqual([]);
});

it.each([undefined, null])("keeps a missing release date unknown (%s)", async date => {
  const response = envelope();
  response.data._uniprot.release_date = date;
  expect((await run(response)).cleaned).toMatchObject({ releases: [{ version: { release_date: null } }] });
});

it.each([null, undefined, "", "2026", "2026_1", 2026, {}, "2026_01\n"])("rejects a missing or malformed release: %j", async release => {
  const response = envelope();
  response.data._uniprot.release = release;
  await expect(run(response)).rejects.toThrow("retaining the prior snapshot");
});

it.each([
  null, { success: false }, { ...envelope(), success: false },
  { ...envelope(), isError: true }, { ...envelope(), staged: true }, { ...envelope(), _staging: {} },
  { ...envelope(), data: { __staged: true } },
  { ...envelope(), data: { ...envelope().data, errors: ["error"] } },
  { ...envelope(), data: { ...envelope().data, results: [] } },
  { ...envelope(), data: { ...envelope().data, results: [{ primaryAccession: "P04637" }] } },
  { ...envelope(), data: { ...envelope().data, results: [{ primaryAccession: "P69905" }, { primaryAccession: "P69905" }] } },
  { ...envelope(), data: { ...envelope().data, _uniprot: { ...envelope().data._uniprot, source_url: "https://example.org/uniprotkb/search" } } },
  envelope("2026_01", {}), envelope("2026_01", " "), envelope("2026_01", "x".repeat(129)),
])("rejects incomplete, failed and unrelated evidence: %j", async response => {
  await expect(run(response)).rejects.toThrow("retaining the prior snapshot");
});
