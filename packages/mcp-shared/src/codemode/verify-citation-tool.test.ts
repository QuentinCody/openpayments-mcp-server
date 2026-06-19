import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../provenance/provenance";
import { createVerifyCitationTool } from "./verify-citation-tool";

type ToolHandler = (
	input: { expected_hash: string; data: unknown },
	extra?: unknown,
) => Promise<{
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: { success: boolean; data?: unknown };
	isError?: boolean;
}>;

/**
 * Register the tool against a fake MCP server that records every
 * `server.tool(name, description, schema, handler)` call, so we can drive the
 * handler directly.
 */
function captureRegistrations(): {
	register: { tool: (...args: unknown[]) => void };
	handlers: Map<string, ToolHandler>;
} {
	const handlers = new Map<string, ToolHandler>();
	const register = {
		tool: (...args: unknown[]) => {
			const name = args[0] as string;
			const handler = args[args.length - 1] as ToolHandler;
			handlers.set(name, handler);
		},
	};
	return { register, handlers };
}

describe("createVerifyCitationTool", () => {
	it("registers a `verify_citation` tool with code-mode schema", () => {
		const tool = createVerifyCitationTool();
		expect(tool.name).toBe("verify_citation");
		expect(tool.schema.expected_hash).toBeDefined();
		expect(tool.schema.data).toBeDefined();

		const { register, handlers } = captureRegistrations();
		tool.register(register);
		expect(handlers.has("verify_citation")).toBe(true);
	});

	it("returns verified:true when the data reproduces the expected hash", async () => {
		const data = { gene: "EGFR", score: 0.92 };
		const expected_hash = await sha256Hex(canonicalJson(data));

		const tool = createVerifyCitationTool();
		const { register, handlers } = captureRegistrations();
		tool.register(register);
		const handler = handlers.get("verify_citation");
		expect(handler).toBeDefined();

		const res = await handler!({ expected_hash, data });
		expect(res.isError).toBeUndefined();
		expect(res.structuredContent?.success).toBe(true);
		const out = res.structuredContent?.data as {
			verified: boolean;
			expected_hash: string;
			actual_hash: string;
		};
		expect(out.verified).toBe(true);
		expect(out.expected_hash).toBe(expected_hash);
		expect(out.actual_hash).toBe(expected_hash);
		expect(res.content[0].text).toMatch(/verified|match/i);
	});

	it("returns verified:false when the data has been tampered with", async () => {
		const original = { gene: "EGFR", score: 0.92 };
		const expected_hash = await sha256Hex(canonicalJson(original));

		const tool = createVerifyCitationTool();
		const { register, handlers } = captureRegistrations();
		tool.register(register);
		const handler = handlers.get("verify_citation")!;

		const res = await handler({ expected_hash, data: { gene: "EGFR", score: 0.01 } });
		// Verification failure is a successful tool call with a negative verdict —
		// not a tool error.
		expect(res.isError).toBeUndefined();
		expect(res.structuredContent?.success).toBe(true);
		const out = res.structuredContent?.data as {
			verified: boolean;
			expected_hash: string;
			actual_hash: string;
		};
		expect(out.verified).toBe(false);
		expect(out.expected_hash).toBe(expected_hash);
		expect(out.actual_hash).not.toBe(expected_hash);
	});

	it("returns an INVALID_ARGUMENTS error when expected_hash is missing/empty", async () => {
		const tool = createVerifyCitationTool();
		const { register, handlers } = captureRegistrations();
		tool.register(register);
		const handler = handlers.get("verify_citation")!;

		const res = await handler({ expected_hash: "", data: { a: 1 } });
		expect(res.isError).toBe(true);
		expect(res.structuredContent?.success).toBe(false);
		expect(res.content[0].text).toMatch(/expected_hash/i);
	});

	it("also registers the mcp_verify_citation alias (dual registration)", async () => {
		const tool = createVerifyCitationTool();
		const { register, handlers } = captureRegistrations();
		tool.register(register);
		expect(handlers.has("mcp_verify_citation")).toBe(true);

		const data = { ok: true };
		const expected_hash = await sha256Hex(canonicalJson(data));
		const res = await handlers.get("mcp_verify_citation")!({ expected_hash, data });
		expect((res.structuredContent?.data as { verified: boolean }).verified).toBe(true);
	});
});
