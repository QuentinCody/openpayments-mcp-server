import { expect, it } from "vitest";
import { runOnce } from "../run-once";
import { ensemblRelease } from "./ensembl-release";

it("detects release drift without row-order churn and keeps native evidence", async () => {
  const query = ensemblRelease.buildQuery({});
  const execute = new Function("api", `return (async () => {${query.params.code}})()`);
  const run = async (releases: number[]) => ({ success: true, data: await execute({ get: async (path: string) => { expect(path).toBe("/info/data"); return { releases, extra: "native" }; } }) });
  const baseline = await runOnce({ source: ensemblRelease, input: {}, run: () => run([115, 114]) });
  const same = await runOnce({ source: ensemblRelease, input: {}, run: () => run([114, 115]), priorContentHash: baseline.contentHash, priorRowSets: baseline.rowSets });
  expect(same.unchanged).toBe(true);
  const changed = await runOnce({ source: ensemblRelease, input: {}, run: () => run([116]), priorContentHash: baseline.contentHash, priorRowSets: baseline.rowSets });
  expect(changed.changes).toMatchObject([{ kind: "changed", materiality: "info" }]);
  expect(changed.cleaned).toMatchObject({ data: { release: [{ native: { extra: "native" } }] } });
  await expect(execute({ get: async () => ({ __staged: true }) })).rejects.toThrow("Invalid or staged");
});
