import { beforeEach, describe, expect, it, vi } from "vitest";

const { shouldStage, stageToDoAndRespond } = vi.hoisted(() => ({
	shouldStage: vi.fn(),
	stageToDoAndRespond: vi.fn(),
}));
vi.mock("../staging/utils", () => ({ shouldStage, stageToDoAndRespond }));

import type { ToolContext } from "../registry/types";
import {
	buildStagedTableSummary,
	createSparqlProxyTool,
	preserveEnvelopeScalars,
	shapeForStaging,
} from "./sparql-proxy";

const selectEnvelope = {
	head: { vars: ["s", "p"] },
	results: {
		bindings: [
			{ s: { value: "urn:a" }, p: { value: "urn:b" } },
			{
				s: { value: "urn:c" },
				p: { type: "bnode" } as unknown as { value: string },
			}, // present key, no .value → null
		],
	},
};

beforeEach(() => {
	shouldStage.mockReset();
	stageToDoAndRespond.mockReset();
});

describe("shapeForStaging", () => {
	it("flattens SELECT bindings into rows (missing vars → null)", () => {
		expect(shapeForStaging(selectEnvelope)).toEqual([
			{ s: "urn:a", p: "urn:b" },
			{ s: "urn:c", p: null },
		]);
	});

	it("passes ASK/CONSTRUCT envelopes through unchanged", () => {
		const ask = { head: {}, boolean: true };
		expect(shapeForStaging(ask)).toBe(ask);
	});
});

describe("buildStagedTableSummary", () => {
	const base = {
		dataAccessId: "d",
		schema: {},
		tablesCreated: [] as string[],
		totalRows: 0,
	} as never;
	it("summarizes zero / one / many tables, with and without row counts", () => {
		expect(
			buildStagedTableSummary({
				...(base as object),
				tablesCreated: [],
				totalRows: 5,
			} as never),
		).toBe("5 rows");
		expect(
			buildStagedTableSummary({
				...(base as object),
				tablesCreated: ["t"],
				totalRows: 3,
			} as never),
		).toBe('table "t" [3 rows]');
		expect(
			buildStagedTableSummary({
				...(base as object),
				tablesCreated: ["t"],
				_staging: { table_row_counts: { t: 9 } },
			} as never),
		).toBe('table "t" [9 rows]');
		expect(
			buildStagedTableSummary({
				...(base as object),
				tablesCreated: ["a", "b"],
				_staging: { table_row_counts: { a: 2 } }, // b has no count
			} as never),
		).toBe("2 tables: a [2], b");
	});

	it("falls back to 0 when row counts and totalRows are absent", () => {
		expect(buildStagedTableSummary({ tablesCreated: [] } as never)).toBe(
			"0 rows",
		);
		expect(buildStagedTableSummary({ tablesCreated: ["t"] } as never)).toBe(
			'table "t" [0 rows]',
		);
	});
});

describe("preserveEnvelopeScalars", () => {
	it("copies small serializable scalars not already present, skipping large/duplicate/non-serializable", () => {
		const staging: Record<string, unknown> = { existing: 1 };
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		preserveEnvelopeScalars(
			{ existing: "dup", small: "ok", big: "x".repeat(2000), circular },
			staging,
		);
		expect(staging.existing).toBe(1); // not overwritten
		expect(staging.small).toBe("ok");
		expect(staging.big).toBeUndefined(); // exceeds 1KB
		expect(staging.circular).toBeUndefined(); // JSON.stringify throws → skipped
	});

	it("ignores non-object originals", () => {
		const staging: Record<string, unknown> = {};
		preserveEnvelopeScalars(null, staging);
		preserveEnvelopeScalars([1, 2], staging);
		expect(staging).toEqual({});
	});
});

describe("createSparqlProxyTool handler", () => {
	const tool = (
		over: Partial<Parameters<typeof createSparqlProxyTool>[0]> = {},
	) =>
		createSparqlProxyTool({
			sparqlFetch: vi.fn(),
			stagingPrefix: "sparql",
			...over,
		});
	const ctx = { sessionId: "sess" } as ToolContext;

	it("rejects an empty query", async () => {
		const t = tool();
		expect(await t.handler({ query: "" } as never, ctx)).toMatchObject({
			code: "invalid_input",
		});
	});

	it("returns the raw envelope when staging is not triggered", async () => {
		shouldStage.mockReturnValue(false);
		const sparqlFetch = vi.fn(async () => selectEnvelope);
		const t = tool({ sparqlFetch, doNamespace: {} });
		const result = await t.handler(
			{ query: "SELECT * WHERE { ?s ?p ?o }" } as never,
			ctx,
		);
		expect(result).toBe(selectEnvelope);
		expect(sparqlFetch).toHaveBeenCalledWith("SELECT * WHERE { ?s ?p ?o }", {
			method: "POST",
			format: "json",
			timeoutMs: 60_000,
		});
	});

	it("auto-stages a large response and wraps it, preserving scalars", async () => {
		shouldStage.mockReturnValue(true);
		stageToDoAndRespond.mockResolvedValue({
			dataAccessId: "da-1",
			schema: { tables: [] },
			tablesCreated: ["bindings"],
			totalRows: 2,
			_staging: { table_row_counts: { bindings: 2 } },
		});
		const envelope = { ...selectEnvelope, queryTimeMs: 12 };
		const t = tool({
			sparqlFetch: vi.fn(async () => envelope),
			doNamespace: {},
		});
		const result = (await t.handler(
			{ query: "SELECT *", method: "GET", timeoutMs: 5 } as never,
			ctx,
		)) as Record<string, unknown>;
		expect(result).toMatchObject({
			__staged: true,
			data_access_id: "da-1",
			total_rows: 2,
			queryTimeMs: 12,
		});
		expect(String(result.message)).toContain('table "bindings" [2 rows]');
	});

	it("maps Error and non-Error fetch failures to an execution error", async () => {
		const t = tool({
			sparqlFetch: vi.fn(async () => {
				throw new Error("upstream 500");
			}),
		});
		expect(await t.handler({ query: "SELECT *" } as never, ctx)).toEqual({
			__sparql_error: true,
			code: "execution_error",
			message: "upstream 500",
		});

		const t2 = tool({
			sparqlFetch: vi.fn(async () => {
				throw "raw failure";
			}),
		});
		expect(await t2.handler({ query: "SELECT *" } as never, ctx)).toMatchObject(
			{ message: "raw failure" },
		);
	});
});
