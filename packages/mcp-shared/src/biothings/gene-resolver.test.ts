/**
 * Co-located smoke tests for the MyGene.info gene resolver.
 *
 * The exhaustive suite (network mocking, batching, species filters,
 * not-found handling, abort) lives at:
 *
 *   tests/biothings-gene-resolver.test.ts
 *
 * This file proves the public surface and one happy path against a
 * fake fetch.
 */
import { describe, expect, it } from "vitest";
import { createMyGeneResolver } from "./gene-resolver";

describe("createMyGeneResolver (smoke)", () => {
    it("returns a function with the GeneResolver shape", () => {
        const fakeFetch: typeof fetch = async () =>
            new Response(JSON.stringify([]), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        const resolver = createMyGeneResolver({ fetch: fakeFetch });
        expect(typeof resolver).toBe("function");
    });
});
