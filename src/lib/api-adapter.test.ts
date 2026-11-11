import { afterEach, expect, it, vi } from "vitest";
import { createOpenPaymentsApiFetch } from "./api-adapter";
afterEach(() => vi.unstubAllGlobals());
it("retains native unfiltered DKAN routes and envelopes", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ results: [], count: 0 })); vi.stubGlobal("fetch", fetcher);
  const params = { limit: 1, keys: true };
  expect(await createOpenPaymentsApiFetch()({ method: "GET", path: "/datastore/query/legacy/0", params })).toEqual({ status: 200, data: { results: [], count: 0 } });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((fetcher.mock.calls[0][0] as URL).searchParams.get("limit")).toBe("1");
});
it("retains the legacy filtered-empty verification probe", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ results: [], count: 0 })).mockResolvedValueOnce(Response.json({ results: [{ record_id: "1" }], count: 1 })); vi.stubGlobal("fetch", fetcher);
  expect(await createOpenPaymentsApiFetch()({ method: "GET", path: "/datastore/query/legacy/0", params: { conditions: [{ property: "recipient_state", value: "TX", operator: "=" }] } })).toMatchObject({ status: 200, data: { results: [], count: 0, __guard: expect.any(Object) } });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
