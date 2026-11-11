import { describe, expect, it } from "vitest";
import { handleRestExecutorResult } from "./execute-tool-result";

const context = {
	source: { id: "example", name: "Example" },
	server: "example",
	tool: "example_execute",
	query: "return api.get('/records')",
};

describe("REST execute result handling", () => {
	it("cites inline response data", async () => {
		const response = await handleRestExecutorResult(
			{ result: [{ id: 1 }] },
			context,
		);
		expect(response.structuredContent).toMatchObject({
			data: [{ id: 1 }],
			_meta: { citation: { result_scope: "structured_content:data" } },
		});
	});

	it.each([100, 0, undefined, -1, 1.5])("separates staged source record counts from storage rows (%s)", async count => {
		const response = await handleRestExecutorResult({ result: {
			__staged: true, data_access_id: "staged_profiles", total_rows: 101,
			returned_record_count: count, _staging: { payload_hash: `sha256:${"a".repeat(64)}` },
		} }, context);
		const sc = response.structuredContent as { _meta: { citation: { record_count?: number } } };
		expect(sc._meta.citation.record_count).toBe(count === 100 || count === 0 ? count : undefined);
	});

	it("binds an auto-staged response to its preserved full payload", async () => {
		const digest = "b".repeat(64);
		const response = await handleRestExecutorResult(
			{
				result: {
					__staged: true,
					data_access_id: "rest_full_1",
					tables_created: ["records"],
					total_rows: 50,
					_staging: { payload_hash: `sha256:${digest}` },
					schema: { large: true },
				},
			},
			context,
		);
		expect(response.structuredContent).toMatchObject({
			data: { data_access_id: "rest_full_1" },
			_meta: {
				payload_hash: `sha256:${digest}`,
				citation: {
					result_scope: "staged:full_result",
					result_hash: digest,
				},
			},
		});
	});

	it("recovers a staged handle after invalid array access", async () => {
		const digest = "c".repeat(64);
		const response = await handleRestExecutorResult(
			{
				error: "slice is not a function",
				logs: ["staged"],
				__stagedResults: [
					{
						__staged: true,
						data_access_id: "rest_full_2",
						_staging: { payload_hash: `sha256:${digest}` },
					},
				],
			},
			context,
		);
		expect(response.structuredContent).toMatchObject({
			_meta: {
				staged: true,
				console_output: "staged",
				citation: { result_hash: digest },
			},
		});
	});

	it("returns a contract error for ordinary executor failures", async () => {
		const response = await handleRestExecutorResult({ error: "upstream failed" });
		expect(response).toMatchObject({
			isError: true,
			structuredContent: { success: false },
		});
	});

	// The recovery above used to be silent: ANY throw after ANY staging came back
	// as a clean success carrying the last staged API response, with a citation
	// vouching for bytes the program never returned. Verified live before the fix
	// — `throw new Error("MARKER")` produced success:true and the marker appeared
	// nowhere in the response.
	it("never reports a crashed program as a completed one", async () => {
		const response = await handleRestExecutorResult(
			{
				error: "DELIBERATE_CRASH_MARKER",
				__stagedResults: [
					{ __staged: true, data_access_id: "rest_full_3", total_rows: 2 },
				],
			},
			context,
		);
		const sc = response.structuredContent as Record<string, unknown>;

		expect(sc.disposition).toBe("partial");
		expect(sc.program_error).toMatchObject({
			code: "PROGRAM_DID_NOT_COMPLETE",
			message: "DELIBERATE_CRASH_MARKER",
			recovered: "last_staged_result",
		});
		// The failure must be legible to a text-only reader too.
		expect(response.content[0].text).toContain("PROGRAM DID NOT COMPLETE");
		expect(response.content[0].text).toContain("DELIBERATE_CRASH_MARKER");
	});

	it("still hands back the staged evidence it recovered", async () => {
		// Recovery is the point — the fetch really did complete before the throw.
		const response = await handleRestExecutorResult(
			{
				error: "boom",
				__stagedResults: [
					{ __staged: true, data_access_id: "rest_full_4", total_rows: 7 },
				],
			},
			context,
		);
		expect(response.structuredContent).toMatchObject({
			data: { data_access_id: "rest_full_4" },
			_meta: { staged: true, data_access_id: "rest_full_4", total_rows: 7 },
		});
	});

	it("marks a completed program as anything but partial", async () => {
		// Guard against the fix over-reaching: a clean run must stay clean.
		const response = await handleRestExecutorResult(
			{ result: [{ id: 1 }] },
			context,
		);
		const sc = response.structuredContent as Record<string, unknown>;
		expect(sc.disposition).toBeUndefined();
		expect(sc.program_error).toBeUndefined();
	});
});

describe("negative-result classification for envelope payloads", () => {
	// Regression: countRecords only understood a top-level Array, so every
	// envelope-shaped empty produced record_count=undefined -> negative_result
	// undefined -> signed as `false`, i.e. an affirmative "this is not a
	// negative" over a result nobody had verified. Asserted through the REAL
	// handler, never through buildCitation alone, which is why it was missed.
	const cite = async (result: unknown) =>
		(
			(await handleRestExecutorResult({ result }, context))
				.structuredContent as {
				_meta: {
					citation: {
						record_count?: number;
						negative_result?: boolean;
						verification?: string;
					};
				};
			}
		)._meta.citation;

	it("classifies an upstream-total envelope empty as a negative", async () => {
		const c = await cite({ total: 0, hits: [] });
		expect(c.record_count).toBe(0);
		expect(c.negative_result).toBe(true);
		expect(c.verification).toBe("unverified-empty");
	});

	it("classifies a sole-array envelope empty as a negative (clingen shape)", async () => {
		const c = await cite({ gene: "ABCA1", curations: [] });
		expect(c.record_count).toBe(0);
		expect(c.negative_result).toBe(true);
	});

	it("does NOT mark a populated envelope as a negative", async () => {
		const c = await cite({ total: 3, hits: [1, 2, 3] });
		expect(c.record_count).toBe(3);
		expect(c.negative_result).toBeUndefined();
	});

	it.each([
		{ count: 2981, next: "page=2", results: [{ id: 1 }, { id: 2 }] },
		{ requested_release: "2022", complete: false, response: { count: 2981, results: [{ id: 1 }, { id: 2 }] } },
		{ hits: { total: { value: 2981, relation: "gte" }, hits: [{ id: 1 }, { id: 2 }] } },
		{ data: { response: { total: 2981, results: [{ id: 1 }, { id: 2 }] } } },
	])("cites returned page rows instead of the upstream matching total: %j", async result => {
		const response = await handleRestExecutorResult({ result }, context);
		expect(response.structuredContent).toMatchObject({
			data: result,
			_meta: { citation: { record_count: 2 } },
		});
	});

	it.each([
		{ total: 2981 },
		{ response: { results: [1] }, data: { results: [2] } },
		{ response: { response: { response: { results: [1] } } } },
		{ response: null },
		{ response: "not a collection" },
	])("leaves totals-only, ambiguous or unsupported wrappers uncounted: %j", async result => {
		expect((await cite(result)).record_count).toBeUndefined();
	});

	it("keeps a fetched empty page distinct from a nonzero upstream total", async () => {
		const c = await cite({ count: 2981, results: [], complete: false });
		expect(c).toMatchObject({ record_count: 0, negative_result: true, verification: "unverified-empty" });
	});

	it("leaves an ambiguous multi-array envelope unclassified", async () => {
		// Two candidate arrays: guessing which holds the records could mislabel a
		// populated result as empty, so the count stays unknown on purpose.
		const c = await cite({ warnings: [], curations: [{ id: 1 }] });
		expect(c.record_count).toBeUndefined();
		expect(c.negative_result).toBeUndefined();
	});

	it("still classifies a bare empty array", async () => {
		const c = await cite([]);
		expect(c.record_count).toBe(0);
		expect(c.negative_result).toBe(true);
	});

	it("does not mistake an RNAcentral QC diagnostic array for an empty record set", async () => {
		const c = await cite({ id: "URS000075BC33_9606", has_issue: false, tcode: false, stopfree: false, messages: [] });
		expect(c.record_count).toBeUndefined();
		expect(c.negative_result).toBeUndefined();
	});

	it("does not infer record counts from arbitrary properties or populated diagnostics", async () => {
		for (const result of [{ warnings: ["upstream warning"] }, { synonyms: [] }, { children: [] }]) {
			const c = await cite(result);
			expect(c.record_count).toBeUndefined();
			expect(c.negative_result).toBeUndefined();
		}
	});
});
