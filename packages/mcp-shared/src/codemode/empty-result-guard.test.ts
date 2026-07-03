import { describe, expect, it } from "vitest";
import {
	EmptyDatasetError,
	type EmptyResultGuardOptions,
	guardEmptyResult,
} from "./empty-result-guard";

type Rows = string[];

function opts(
	over: Partial<EmptyResultGuardOptions<Rows>>,
): EmptyResultGuardOptions<Rows> {
	return {
		isEmpty: (d) => d.length === 0,
		probe: async () => ["probe-row"],
		...over,
	};
}

describe("guardEmptyResult", () => {
	it("passes non-empty results through without any upstream calls", async () => {
		let probes = 0;
		const out = await guardEmptyResult(["row"], {
			...opts({}),
			probe: async () => {
				probes++;
				return [];
			},
		});
		expect(out.data).toEqual(["row"]);
		expect(out.guard).toBeUndefined();
		expect(probes).toBe(0);
	});

	it("recovers a transient empty via an optional retry and flags it", async () => {
		let probes = 0;
		const out = await guardEmptyResult([], {
			...opts({ refetch: async () => ["recovered"] }),
			probe: async () => {
				probes++;
				return [];
			},
		});
		expect(out.data).toEqual(["recovered"]);
		expect(out.guard?.transient_empty_recovered).toBe(true);
		expect(probes).toBe(0); // probe never needed
	});

	it("certifies a stable empty when the unfiltered probe finds rows", async () => {
		const out = await guardEmptyResult([], opts({}));
		expect(out.data).toEqual([]);
		expect(out.guard?.verified_empty).toBe(true);
		expect(out.guard?.note).toMatch(/certified negative/i);
	});

	it("throws EmptyDatasetError when the probe is ALSO empty (dead dataset)", async () => {
		await expect(
			guardEmptyResult([], opts({ probe: async () => [] })),
		).rejects.toBeInstanceOf(EmptyDatasetError);
		await expect(
			guardEmptyResult([], opts({ probe: async () => [] })),
		).rejects.toThrow(/do not interpret/i);
	});

	it("degrades gracefully (unverified empty) when the probe errors/times out", async () => {
		const out = await guardEmptyResult(
			[],
			opts({
				probe: async () => {
					throw new Error("timeout");
				},
			}),
		);
		// Never worse than status quo: original empty returned, no strong annotation.
		expect(out.data).toEqual([]);
		expect(out.guard).toBeUndefined();
	});

	it("works with no refetch supplied (probe-only hot path)", async () => {
		const out = await guardEmptyResult([], {
			isEmpty: (d) => d.length === 0,
			probe: async () => ["live"],
		});
		expect(out.guard?.verified_empty).toBe(true);
	});

	it("survives a failing retry and still certifies via the probe", async () => {
		const out = await guardEmptyResult(
			[],
			opts({
				refetch: async () => {
					throw new Error("retry blew up");
				},
			}),
		);
		expect(out.guard?.verified_empty).toBe(true);
	});

	it("uses isProbeEmpty for the probe payload when provided", async () => {
		const out = await guardEmptyResult(
			[],
			opts({
				probe: async () => [],
				isProbeEmpty: () => false,
			}),
		);
		expect(out.guard?.verified_empty).toBe(true);
	});

	it("logs guard events (verified, recovered, dead-dataset, inconclusive)", async () => {
		const logs: string[] = [];
		await guardEmptyResult([], opts({ log: (m) => logs.push(m) }));
		expect(logs.some((l) => l.startsWith("verified_empty"))).toBe(true);

		logs.length = 0;
		await guardEmptyResult(
			[],
			opts({ refetch: async () => ["r"], log: (m) => logs.push(m) }),
		);
		expect(logs.some((l) => l.startsWith("transient_empty_recovered"))).toBe(
			true,
		);

		logs.length = 0;
		await expect(
			guardEmptyResult(
				[],
				opts({ probe: async () => [], log: (m) => logs.push(m) }),
			),
		).rejects.toThrow();
		expect(logs.some((l) => l.startsWith("dataset_empty_suspected"))).toBe(true);

		logs.length = 0;
		await guardEmptyResult(
			[],
			opts({
				probe: async () => {
					throw new Error("x");
				},
				log: (m) => logs.push(m),
			}),
		);
		expect(logs.some((l) => l.startsWith("probe_inconclusive"))).toBe(true);
	});
});
