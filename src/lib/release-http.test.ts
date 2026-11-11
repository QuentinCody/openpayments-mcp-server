import { afterEach, expect, it, vi } from "vitest";
import { hash, releaseRead } from "./release-http";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("hashes equivalent metadata consistently without losing array order", async () => {
  expect(await hash({ a: 1, b: [1, 2] })).toBe(await hash({ b: [1, 2], a: 1 }));
  expect(await hash({ a: 1, b: [1, 2] })).not.toBe(await hash({ a: 1, b: [2, 1] }));
});
it("encodes native DKAN conditions once on a fixed host and disallows redirects", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ results: [] })); vi.stubGlobal("fetch", fetcher);
  await releaseRead("/datastore/query/id/0", { conditions: [{ property: "name", value: "A&B%", operator: "=" }] }, Date.now() + 1000);
  const url = fetcher.mock.calls[0][0] as URL;
  expect(url.origin).toBe("https://openpaymentsdata.cms.gov");
  expect(url.searchParams.get("conditions[0][value]")).toBe("A&B%");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
});
it.each([404, 429, 503])("preserves upstream status %s", async status => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status })));
  await expect(releaseRead("/search", {}, Date.now() + 1000)).rejects.toMatchObject({ status });
});
it.each(["null", "bad", '{"error":"unavailable"}'])("rejects invalid response %s", async body => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  await expect(releaseRead("/search", {}, Date.now() + 1000)).rejects.toMatchObject({ status: 502 });
});
it("caps actual bytes even when content-length lies", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('["éé"]', { headers: { "content-length": "1" } })));
  await expect(releaseRead("/search", {}, Date.now() + 1000, 5)).rejects.toMatchObject({ status: 502 });
});
it("times out a stalled body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream())));
  const result = expect(releaseRead("/search", {}, Date.now() + 1000)).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(1000); await result;
});

it("retains complete native errors and hashes on both HTTP and JSON error paths", async () => {
  const native = { message: "α😀".repeat(20000), detail: { field: "missing", future: null } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(native, { status: 400 })));
  await expect(releaseRead("/search", {}, Date.now() + 1000)).rejects.toMatchObject({ status: 400, data: { native_error: native, response_evidence: { response_sha256: await hash(native), upstream_status: 400 } } });
  const invalid = { errors: [native] };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(invalid)));
  await expect(releaseRead("/search", {}, Date.now() + 1000)).rejects.toMatchObject({ status: 502, data: { native_error: invalid } });
});
