import { describe, it, expect } from "vitest";
import {
	createCodeModeResponse,
	createCodeModeError,
	withCodeMode,
	ErrorCodes,
	type SectionSource,
	type ResponseMeta,
	type SuccessResponse,
} from "./response";

describe("createCodeModeResponse", () => {
	it("returns content + structuredContent with data", () => {
		const result = createCodeModeResponse({ gene: "BRAF" });
		expect(result.content[0].type).toBe("text");
		expect(result.structuredContent?.success).toBe(true);
		expect(result.structuredContent?.data).toEqual({ gene: "BRAF" });
	});

	it("uses textSummary when provided", () => {
		const result = createCodeModeResponse({ x: 1 }, { textSummary: "hello" });
		expect(result.content[0].text).toBe("hello");
	});

	it("truncates long JSON in text content", () => {
		const bigData = { text: "a".repeat(500) };
		const result = createCodeModeResponse(bigData, { maxPreviewChars: 50 });
		expect(result.content[0].text).toContain("[truncated");
	});

	it("includes _meta when provided", () => {
		const result = createCodeModeResponse({ x: 1 }, { meta: { fetched_at: "now" } });
		expect(result.structuredContent?._meta?.fetched_at).toBe("now");
	});

	it("omits _meta when meta is empty", () => {
		const result = createCodeModeResponse({ x: 1 }, { meta: {} });
		expect(result.structuredContent?._meta).toBeUndefined();
	});

	it("supports provenance in _meta", () => {
		const provenance: SectionSource[] = [
			{ key: "identity", label: "Identity", sources: ["NCBI Gene"] },
			{ key: "pathways", label: "Pathways", sources: ["Reactome", "KEGG"] },
		];
		const result = createCodeModeResponse(
			{ gene: "TP53" },
			{ meta: { provenance } },
		);
		const meta = result.structuredContent?._meta as ResponseMeta;
		expect(meta.provenance).toHaveLength(2);
		expect(meta.provenance![0].key).toBe("identity");
		expect(meta.provenance![1].sources).toEqual(["Reactome", "KEGG"]);
	});
});

describe("createCodeModeError", () => {
	it("returns error content with isError flag", () => {
		const result = createCodeModeError("NOT_FOUND", "Gene not found");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Gene not found");
		expect(result.structuredContent?.success).toBe(false);
		expect(result.structuredContent?.error.code).toBe("NOT_FOUND");
	});

	it("includes details when provided", () => {
		const result = createCodeModeError("API_ERROR", "fail", { status: 500 });
		expect(result.structuredContent?.error.details).toEqual({ status: 500 });
	});
});

describe("withCodeMode", () => {
	it("wraps a successful function", async () => {
		const fn = async (args: { id: string }) => ({ name: args.id });
		const wrapped = withCodeMode(fn, { toolName: "test_tool" });
		const result = await wrapped({ id: "BRAF" });
		expect(result.structuredContent?.success).toBe(true);
	});

	it("catches errors and maps to error codes", async () => {
		const fn = async () => { throw new Error("not found"); };
		const wrapped = withCodeMode(fn, { toolName: "test_tool" });
		const result = await wrapped({});
		expect(result.isError).toBe(true);
		const sc = result.structuredContent;
		expect(sc).toBeDefined();
		expect(sc!.success).toBe(false);
		if (!sc!.success) {
			expect(sc!.error.code).toBe(ErrorCodes.NOT_FOUND);
		}
	});

	it("applies transformResult and extractMeta", async () => {
		const fn = async () => ({ raw: true, source: "test" });
		const wrapped = withCodeMode(fn, {
			toolName: "test_tool",
			transformResult: () => ({ transformed: true }),
			extractMeta: (r) => ({ source: r.source }),
		});
		const result = await wrapped({});
		const sc = result.structuredContent;
		expect(sc).toBeDefined();
		if (sc!.success) {
			expect(sc!.data).toEqual({ transformed: true });
			expect(sc!._meta?.source).toBe("test");
		}
	});
});

describe("ResponseMeta type", () => {
	it("allows provenance field in SuccessResponse", () => {
		const response: SuccessResponse<{ gene: string }> = {
			success: true,
			data: { gene: "BRAF" },
			_meta: {
				fetched_at: "2026-04-08T00:00:00Z",
				provenance: [
					{ key: "identity", label: "Identity", sources: ["Ensembl"] },
				],
			},
		};
		expect(response._meta?.provenance).toHaveLength(1);
	});
});
