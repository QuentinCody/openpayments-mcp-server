import { describe, expect, it } from "vitest";
import {
	buildCitation,
	canonicalJson,
	type SourceDescriptor,
	sha256Hex,
	verifyCitation,
	verifyResultHash,
} from "./provenance";

const SOURCE: SourceDescriptor = {
	id: "opentargets",
	name: "Open Targets",
	url: "https://www.opentargets.org",
	license: "CC0 1.0",
};
const TS = "2026-06-17T00:00:00.000Z";

describe("canonicalJson", () => {
	it("sorts object keys so structurally-equal inputs hash identically", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
	});
	it("preserves array order and drops undefined", () => {
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
	});
});

describe("sha256Hex", () => {
	it("matches known SHA-256 vectors", async () => {
		expect(await sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(await sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("buildCitation", () => {
	it("produces a verifiable citation carrying source identity + query/result hashes", async () => {
		const c = await buildCitation({
			source: SOURCE,
			server: "opentargets",
			tool: "opentargets_execute",
			query: "{ target }",
			result: { name: "EGFR" },
			retrievedAt: TS,
			recordCount: 1,
		});
		expect(c.source.name).toBe("Open Targets");
		expect(c.server).toBe("opentargets");
		expect(c.tool).toBe("opentargets_execute");
		expect(c.retrieved_at).toBe(TS);
		expect(c.query_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(c.result_hash).toBe(
			await sha256Hex(canonicalJson({ name: "EGFR" })),
		);
		expect(c.record_count).toBe(1);
		// The human/agent-readable line names the source and embeds the integrity anchor.
		expect(c.text).toContain("Open Targets");
		expect(c.text).toContain(c.result_hash.slice(0, 12));
		expect(c.text).toContain("https://www.opentargets.org");
	});

	it("is content-addressed: same result → same hash, different result → different hash", async () => {
		const base = {
			source: SOURCE,
			server: "opentargets",
			tool: "opentargets_execute",
			query: "q",
			retrievedAt: TS,
		};
		const a = await buildCitation({ ...base, result: { x: 1 } });
		const a2 = await buildCitation({ ...base, result: { x: 1 } });
		const b = await buildCitation({ ...base, result: { x: 2 } });
		expect(a.result_hash).toBe(a2.result_hash);
		expect(a.result_hash).not.toBe(b.result_hash);
	});

	it("hashes the query so identical data from a different question is distinguishable", async () => {
		const base = {
			source: SOURCE,
			server: "opentargets",
			tool: "opentargets_execute",
			result: { x: 1 },
			retrievedAt: TS,
		};
		const a = await buildCitation({ ...base, query: "question-1" });
		const b = await buildCitation({ ...base, query: "question-2" });
		expect(a.query_hash).not.toBe(b.query_hash);
		expect(a.result_hash).toBe(b.result_hash);
	});

	it("carries a data_access_id when the cited result was staged", async () => {
		const c = await buildCitation({
			source: SOURCE,
			server: "opentargets",
			tool: "opentargets_execute",
			query: "q",
			result: { __staged: true },
			retrievedAt: TS,
			dataAccessId: "ot_abc123",
		});
		expect(c.data_access_id).toBe("ot_abc123");
	});

	it("flags a bare zero-record result as an UNVERIFIED negative", async () => {
		const c = await buildCitation({
			source: SOURCE,
			server: "cms-partd",
			tool: "partd_execute",
			query: "return await api.get('/prescriber/search',{Prscrbr_NPI:'x'})",
			result: [],
			retrievedAt: TS,
			recordCount: 0,
		});
		expect(c.negative_result).toBe(true);
		expect(c.verification).toBe("unverified-empty");
		expect(c.text).toContain("NEGATIVE (unverified empty");
	});

	it("marks a probe-certified empty (guard-annotated) as a stronger negative", async () => {
		const c = await buildCitation({
			source: SOURCE,
			server: "cms-partd",
			tool: "partd_execute",
			query: "q",
			result: { __guard: { verified_empty: true }, data: [] },
			retrievedAt: TS,
			recordCount: 0,
		});
		expect(c.negative_result).toBe(true);
		expect(c.verification).toBe("probe-certified-empty");
		expect(c.text).toContain("NEGATIVE (probe-certified empty)");
	});

	it("detects a guard annotation even without an explicit recordCount", async () => {
		const c = await buildCitation({
			source: SOURCE,
			server: "cms-partd",
			tool: "partd_execute",
			query: "q",
			result: { __guard: { verified_empty: true } },
			retrievedAt: TS,
		});
		expect(c.verification).toBe("probe-certified-empty");
	});

	it("does NOT flag a normal non-empty result as negative", async () => {
		const c = await buildCitation({
			source: SOURCE,
			server: "opentargets",
			tool: "opentargets_execute",
			query: "q",
			result: [{ x: 1 }],
			retrievedAt: TS,
			recordCount: 1,
		});
		expect(c.negative_result).toBeUndefined();
		expect(c.verification).toBeUndefined();
		expect(c.text).not.toContain("NEGATIVE");
	});
});

describe("verifyResultHash", () => {
	it("verifies a matching result (recomputed hash equals expected)", async () => {
		const result = { name: "EGFR", id: "ENSG00000146648" };
		const expected = await sha256Hex(canonicalJson(result));
		const v = await verifyResultHash(expected, result);
		expect(v.verified).toBe(true);
		expect(v.expected_hash).toBe(expected);
		expect(v.actual_hash).toBe(expected);
	});

	it("uses the same canonicalization — key order does not matter", async () => {
		const expected = await sha256Hex(canonicalJson({ a: 1, b: 2 }));
		const v = await verifyResultHash(expected, { b: 2, a: 1 });
		expect(v.verified).toBe(true);
	});

	it("fails for a tampered result and still reports both hashes", async () => {
		const original = { name: "EGFR" };
		const expected = await sha256Hex(canonicalJson(original));
		const v = await verifyResultHash(expected, { name: "TAMPERED" });
		expect(v.verified).toBe(false);
		expect(v.expected_hash).toBe(expected);
		expect(v.actual_hash).not.toBe(expected);
		expect(v.actual_hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("verifyCitation", () => {
	it("round-trips: a real buildCitation() output verifies true against its data", async () => {
		const result = {
			gene: "EGFR",
			associations: [{ disease: "NSCLC", score: 0.92 }],
		};
		const c = await buildCitation({
			source: SOURCE,
			server: "opentargets",
			tool: "opentargets_execute",
			query: "{ target { id } }",
			result,
			retrievedAt: TS,
			recordCount: 1,
		});
		const v = await verifyCitation(c, result);
		expect(v.verified).toBe(true);
		expect(v.expected_hash).toBe(c.result_hash);
		expect(v.actual_hash).toBe(c.result_hash);
	});

	it("detects tampering: altered data does not match the citation's result_hash", async () => {
		const c = await buildCitation({
			source: SOURCE,
			server: "opentargets",
			tool: "opentargets_execute",
			query: "q",
			result: { value: 1 },
			retrievedAt: TS,
		});
		const v = await verifyCitation(c, { value: 999 });
		expect(v.verified).toBe(false);
		expect(v.expected_hash).toBe(c.result_hash);
	});
});
