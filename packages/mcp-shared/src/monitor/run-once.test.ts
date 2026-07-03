import { describe, expect, it } from "vitest";
import { extractRowSets } from "./canonicalize";
import { runOnce } from "./run-once";
import type { SourceModule } from "./types";

const source: SourceModule = {
	id: "test",
	label: "Test",
	profile: {
		stripKeys: ["ts"],
		tables: [{ table: "rows", path: "rows", keyFields: ["k"] }],
	},
	buildQuery: (input) => ({ server: "x", tool: "t", params: input }),
	classify: (c) => ({
		materiality: c.kind === "removed" ? "high" : "info",
		label: `${c.kind} ${c.key}`,
	}),
};

describe("runOnce", () => {
	it("produces a content hash and a baseline (empty) diff on first run", async () => {
		const r = await runOnce({
			source,
			input: {},
			run: async () => ({ ts: 1, rows: [{ k: "a", v: 1 }] }),
		});
		expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
		expect(r.changes).toEqual([]);
		expect(r.unchanged).toBe(false);
	});

	it("detects no change when content is identical (volatile envelope stripped)", async () => {
		const prior = extractRowSets({ rows: [{ k: "a", v: 1 }] }, source.profile);
		const first = await runOnce({
			source,
			input: {},
			run: async () => ({ ts: 1, rows: [{ k: "a", v: 1 }] }),
		});
		const second = await runOnce({
			source,
			input: {},
			run: async () => ({ ts: 999, rows: [{ k: "a", v: 1 }] }),
			priorRowSets: prior,
			priorContentHash: first.contentHash,
		});
		expect(second.unchanged).toBe(true);
		expect(second.changes).toEqual([]);
	});

	it("detects and classifies a removed row as high materiality", async () => {
		const prior = extractRowSets(
			{
				rows: [
					{ k: "a", v: 1 },
					{ k: "b", v: 2 },
				],
			},
			source.profile,
		);
		const r = await runOnce({
			source,
			input: {},
			run: async () => ({ rows: [{ k: "a", v: 1 }] }),
			priorRowSets: prior,
			priorContentHash: "different",
		});
		const removed = r.changes.find((c) => c.kind === "removed");
		expect(removed?.materiality).toBe("high");
		expect(removed?.label).toBe("removed b");
		expect(r.unchanged).toBe(false);
	});
});
