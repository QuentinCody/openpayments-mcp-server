import { describe, expect, it } from "vitest";
import { handleExecutorResult } from "./graphql-execute-result";

type Sc = any;

describe("handleExecutorResult", () => {
	it("wraps a plain success result as a code-mode response", async () => {
		const r = await handleExecutorResult({ result: { gene: "EGFR" } });
		expect(r.structuredContent).toMatchObject({
			success: true,
			data: { gene: "EGFR" },
		});
		expect(typeof (r.structuredContent as Sc)._meta.executed_at).toBe("string");
		expect(r.isError).toBeUndefined();
	});

	it("returns an error response when the isolate reported an error", async () => {
		const r = await handleExecutorResult({ error: "boom" });
		expect(r.isError).toBe(true);
		expect((r.structuredContent as Sc).success).toBe(false);
		expect((r.structuredContent as Sc).error.message).toContain("boom");
	});

	it("surfaces staging metadata from a __staged result and strips large fields", async () => {
		const r = await handleExecutorResult({
			result: {
				__staged: true,
				data_access_id: "rcsb_pdb_1",
				tables_created: ["result_set"],
				total_rows: 25,
				schema: { big: true },
			},
		});
		const sc = r.structuredContent as Sc;
		expect(sc._meta.staged).toBe(true);
		expect(sc._meta.data_access_id).toBe("rcsb_pdb_1");
		expect(sc._meta.total_rows).toBe(25);
		expect(sc.data.schema).toBeUndefined();
	});

	it("attaches a verifiable citation when a source is declared", async () => {
		const r = await handleExecutorResult(
			{ result: [{ id: 1 }, { id: 2 }] },
			{
				source: {
					id: "rcsb_pdb",
					name: "RCSB PDB",
					url: "https://www.rcsb.org",
					license: "CC0 1.0",
				},
				server: "rcsb_pdb",
				tool: "rcsb_pdb_execute",
				query: "{ entry(entry_id: \"4HHB\") { rcsb_id } }",
			},
		);
		const sc = r.structuredContent as Sc;
		expect(sc._meta.citation).toBeDefined();
		expect(sc._meta.citation.source.id).toBe("rcsb_pdb");
		expect(typeof sc._meta.citation.result_hash).toBe("string");
	});

	it("cites the preserved full payload for an auto-staged result", async () => {
		const digest = "a".repeat(64);
		const r = await handleExecutorResult(
			{
				result: {
					__staged: true,
					data_access_id: "rcsb_pdb_full_1",
					tables_created: ["result_set"],
					total_rows: 25,
					_staging: { payload_hash: `sha256:${digest}` },
					schema: { big: true },
				},
			},
			{
				source: { id: "rcsb_pdb", name: "RCSB PDB" },
				server: "rcsb_pdb",
				tool: "rcsb_pdb_execute",
				query: "return gql.query('query { entries { id } }')",
			},
		);
		const sc = r.structuredContent as Sc;
		expect(sc._meta.citation).toMatchObject({
			result_scope: "staged:full_result",
			result_hash: digest,
			data_access_id: "rcsb_pdb_full_1",
		});
		expect(sc._meta.payload_hash).toBe(`sha256:${digest}`);
	});

	it("recovers staging metadata when the error came from accessing a staged array", async () => {
		const r = await handleExecutorResult({
			error: "x.slice is not a function",
			__stagedResults: [
				{
					__staged: true,
					data_access_id: "rcsb_pdb_2",
					tables_created: ["result_set"],
					total_rows: 100,
					schema: { big: 1 },
				},
			],
			logs: ["note"],
		});
		const sc = r.structuredContent as Sc;
		expect(sc._meta.staged).toBe(true);
		expect(sc._meta.data_access_id).toBe("rcsb_pdb_2");
		expect(sc._meta.console_output).toBe("note");
		expect(sc.data.schema).toBeUndefined();
	});

	it("includes console output on a successful result", async () => {
		const r = await handleExecutorResult({
			result: { ok: 1 },
			logs: ["hello", "world"],
		});
		const sc = r.structuredContent as Sc;
		expect(sc._meta.console_output).toBe("hello\nworld");
	});
});
