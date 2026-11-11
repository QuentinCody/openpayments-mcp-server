import { describe, expect, it, vi } from "vitest";
import { genebassGeneBurden } from "./genebass.js";

describe("genebass adapter", () => {
	it("uses the provider client PheWAS route and preserves the native envelope", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ gene: { gene_id: "ENSG00000147883" }, phewas: [] }), {
				status: 200,
			});
		};
		const result = await genebassGeneBurden("ENSG00000147883", "pLoF", {
			fetchImpl: f,
		});
		expect(captured[0]).toBe("https://main.genebass.org/api/phewas/ENSG00000147883?burdenSet=pLoF");

		expect(result).toEqual({ gene: { gene_id: "ENSG00000147883" }, phewas: [] });
	});
});

it("encodes compound sets and prevents extra parameters from overriding the requested set", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({ phewas: [] }));
  await genebassGeneBurden("ENSG1", "missense|LC", { fetchImpl: fetcher, params: { burdenSet: "synonymous" } });
  expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("burdenSet")).toBe("missense|LC");
});

it.each(["../phenotypes", "ENSG1/extra", "ENSG1.2"])("rejects invalid gene paths before fetching: %s", async gene => {
  const fetcher = vi.fn();
  await expect(genebassGeneBurden(gene, "pLoF", { fetchImpl: fetcher })).rejects.toThrow("Ensembl");
  expect(fetcher).not.toHaveBeenCalled();
});
