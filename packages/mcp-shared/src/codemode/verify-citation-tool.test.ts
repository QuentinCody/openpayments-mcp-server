import { describe, expect, it } from "vitest";
import {
	buildCitation,
	type Citation,
	canonicalJson,
	sha256Hex,
} from "../provenance/provenance";
import {
	exportCitationPublicJwk,
	generateCitationKeypair,
	signCitation,
} from "../provenance/signing";
import {
	createVerifyCitationTool,
	registerVerifyCitationOnce,
	structuralDrift,
} from "./verify-citation-tool";

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
	it("registers both verifier aliases with the code-mode schema", () => {
		const tool = createVerifyCitationTool();
		expect(tool.name).toBe("verify_citation");
		expect(tool.schema.expected_hash).toBeDefined();
		expect(tool.schema.data).toBeDefined();

		const { register, handlers } = captureRegistrations();
		tool.register(register);
		expect(handlers.has("verify_citation")).toBe(true);
		expect(handlers.has("mcp_verify_citation")).toBe(true);
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

		const res = await handler({
			expected_hash,
			data: { gene: "EGFR", score: 0.01 },
		});
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

	it("honors the fleet dual-registration contract when explicitly enabled", () => {
		const tool = createVerifyCitationTool();
		const { register, handlers } = captureRegistrations();
		tool.register(register);
		expect(handlers.has("verify_citation")).toBe(true);
		expect(handlers.has("mcp_verify_citation")).toBe(true);
		expect([...handlers.keys()]).toEqual([
			"mcp_verify_citation",
			"verify_citation",
		]);
	});

	it("verifies query identity and emits a replay_hint (replay protocol)", async () => {
		const code =
			"return await api.get('/prescriber/search',{Prscrbr_NPI:'1558775700',year:'2022'})";
		const query_hash = await sha256Hex(canonicalJson(code));

		const tool = createVerifyCitationTool();
		const { register, handlers } = captureRegistrations();
		tool.register(register);
		const handler = handlers.get("verify_citation") as unknown as (i: {
			query_hash: string;
			query: unknown;
		}) => Promise<{
			structuredContent?: { data?: unknown };
			content: Array<{ text: string }>;
		}>;

		const res = await handler({ query_hash, query: code });
		const out = res.structuredContent?.data as {
			verified: boolean;
			query_check?: { verified: boolean };
			replay_hint?: string;
		};
		expect(out.verified).toBe(true);
		expect(out.query_check?.verified).toBe(true);
		expect(out.replay_hint).toMatch(/re-run this exact code/i);
	});

	it("flags a query that is NOT the cited one (fabricated-claim adjudication)", async () => {
		const realCode = "return await api.get('/x',{a:1})";
		const query_hash = await sha256Hex(canonicalJson(realCode));

		const tool = createVerifyCitationTool();
		const { register, handlers } = captureRegistrations();
		tool.register(register);
		const handler = handlers.get("verify_citation") as unknown as (i: {
			query_hash: string;
			query: unknown;
		}) => Promise<{ structuredContent?: { data?: unknown } }>;

		const res = await handler({
			query_hash,
			query: "return await api.get('/x',{a:2})",
		});
		const out = res.structuredContent?.data as {
			verified: boolean;
			query_check?: { verified: boolean };
			replay_hint?: string;
		};
		expect(out.verified).toBe(false);
		expect(out.query_check?.verified).toBe(false);
		expect(out.replay_hint).toBeUndefined();
	});

	it("verifies result integrity AND query identity together (both pairs)", async () => {
		const data = { rows: 3 };
		const expected_hash = await sha256Hex(canonicalJson(data));
		const code = "return 3";
		const query_hash = await sha256Hex(canonicalJson(code));

		const tool = createVerifyCitationTool();
		const { register, handlers } = captureRegistrations();
		tool.register(register);
		const handler = handlers.get("verify_citation") as unknown as (i: {
			expected_hash: string;
			data: unknown;
			query_hash: string;
			query: unknown;
		}) => Promise<{ structuredContent?: { data?: unknown } }>;

		const res = await handler({ expected_hash, data, query_hash, query: code });
		const out = res.structuredContent?.data as {
			verified: boolean;
			expected_hash?: string;
			query_check?: { verified: boolean };
			replay_hint?: string;
		};
		expect(out.verified).toBe(true);
		// back-compat: result-integrity hashes stay flat at top level
		expect(out.expected_hash).toBe(expected_hash);
		expect(out.query_check?.verified).toBe(true);
		// no replay hint when the result was already verified this call
		expect(out.replay_hint).toBeUndefined();
	});

	it("errors when neither verification pair is supplied", async () => {
		const tool = createVerifyCitationTool();
		const { register, handlers } = captureRegistrations();
		tool.register(register);
		const handler = handlers.get("verify_citation")!;
		const res = await handler({} as { expected_hash: string; data: unknown });
		expect(res.isError).toBe(true);
	});
});

/**
 * The optional compatibility tool remains idempotent for setup composition.
 * The MCP SDK throws `Tool <name> is already registered` on a duplicate name,
 * so repeated setup must be a no-op rather than a crash on boot.
 */
describe("registerVerifyCitationOnce", () => {
	/** Fake server that throws on duplicate names, exactly like the MCP SDK. */
	function strictServer(): {
		server: { tool: (...args: unknown[]) => void };
		names: string[];
	} {
		const names: string[] = [];
		return {
			names,
			server: {
				tool: (...args: unknown[]) => {
					const name = args[0] as string;
					if (names.includes(name)) {
						throw new Error(`Tool ${name} is already registered`);
					}
					names.push(name);
				},
			},
		};
	}

	it("registers both aliases on first call", () => {
		const { server, names } = strictServer();
		expect(registerVerifyCitationOnce(server)).toBe(true);
		expect(names).toEqual(["mcp_verify_citation", "verify_citation"]);
	});

	it("is a no-op on a second call for the same server", () => {
		const { server, names } = strictServer();
		registerVerifyCitationOnce(server);
		expect(registerVerifyCitationOnce(server)).toBe(false);
		expect(names).toHaveLength(2);
	});

	it("registers independently on a different server instance", () => {
		const a = strictServer();
		const b = strictServer();
		registerVerifyCitationOnce(a.server);
		expect(registerVerifyCitationOnce(b.server)).toBe(true);
		expect(b.names).toHaveLength(2);
	});

	it("makes a hand-written createVerifyCitationTool().register() idempotent", () => {
		const { server, names } = strictServer();
		registerVerifyCitationOnce(server);
		expect(() => createVerifyCitationTool().register(server)).not.toThrow();
		expect(names).toHaveLength(2);
	});

	it("still installs a working handler through the once-guard", async () => {
		const handlers = new Map<string, ToolHandler>();
		const server = {
			tool: (...args: unknown[]) => {
				handlers.set(args[0] as string, args[args.length - 1] as ToolHandler);
			},
		};
		registerVerifyCitationOnce(server);
		const data = { gene: "TREM2", variant: "R47H" };
		const expected_hash = await sha256Hex(canonicalJson(data));
		const res = await handlers.get("verify_citation")!({ expected_hash, data });
		expect(
			(res.structuredContent?.data as { verified: boolean }).verified,
		).toBe(true);
	});
});

describe("structuralDrift", () => {
	it("reports no change for structurally identical values", () => {
		const d = structuralDrift({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] });
		expect(d.changed).toBe(false);
		expect(d.added).toEqual([]);
		expect(d.removed).toEqual([]);
		expect(d.changed_paths).toEqual([]);
		expect(d.truncated).toBe(false);
	});

	it("is insensitive to object key order (matches canonical hashing)", () => {
		const d = structuralDrift({ a: 1, b: 2 }, { b: 2, a: 1 });
		expect(d.changed).toBe(false);
	});

	it("names the path of a changed leaf value", () => {
		const d = structuralDrift(
			{ gene: "TREM2", af: 0.002 },
			{ gene: "TREM2", af: 0.9 },
		);
		expect(d.changed).toBe(true);
		expect(d.changed_paths).toEqual(["af"]);
		expect(d.added).toEqual([]);
		expect(d.removed).toEqual([]);
	});

	it("detects added and removed keys", () => {
		const d = structuralDrift({ a: 1, gone: true }, { a: 1, fresh: 2 });
		expect(d.removed).toEqual(["gone"]);
		expect(d.added).toEqual(["fresh"]);
		expect(d.changed_paths).toEqual([]);
	});

	it("descends into arrays and nested objects with index paths", () => {
		const d = structuralDrift({ rows: [{ id: 1 }] }, { rows: [{ id: 2 }] });
		expect(d.changed_paths).toEqual(["rows[0].id"]);
	});

	it("caps wide diffs and flags truncation", () => {
		const base: Record<string, number> = {};
		const next: Record<string, number> = {};
		for (let i = 0; i < 40; i++) {
			base[`k${i}`] = 0;
			next[`k${i}`] = 1;
		}
		const d = structuralDrift(base, next);
		expect(d.changed).toBe(true);
		expect(d.truncated).toBe(true);
		expect(d.changed_paths.length).toBeLessThanOrEqual(25);
	});
});

describe("verify_citation drift / replay adjudication", () => {
	async function callVerify(input: Record<string, unknown>) {
		const { register, handlers } = captureRegistrations();
		createVerifyCitationTool().register(register);
		const handler = handlers.get("verify_citation") as unknown as (
			i: Record<string, unknown>,
		) => Promise<{
			isError?: boolean;
			structuredContent?: { data?: unknown };
		}>;
		return handler(input);
	}

	it("reports no drift when the fresh result reproduces the cited hash", async () => {
		const cited = { gene: "TREM2", risk: "R47H" };
		const H = await sha256Hex(canonicalJson(cited));
		const res = await callVerify({
			expected_hash: H,
			data: cited,
			baseline: cited,
		});
		const out = res.structuredContent?.data as {
			verified: boolean;
			drift: { changed: boolean; baseline_matches_expected?: boolean };
		};
		expect(out.verified).toBe(true);
		expect(out.drift.changed).toBe(false);
		expect(out.drift.baseline_matches_expected).toBe(true);
	});

	it("flags source drift while confirming the cited original was authentic", async () => {
		// The CLAUDE.md scenario: adjudicate by replay. expected = cited hash,
		// data = fresh re-fetch (drifted), baseline = the originally-cited result.
		const cited = { gene: "TREM2", af: 0.002 };
		const fresh = { gene: "TREM2", af: 0.9 };
		const H = await sha256Hex(canonicalJson(cited));
		const res = await callVerify({
			expected_hash: H,
			data: fresh,
			baseline: cited,
		});
		const out = res.structuredContent?.data as {
			verified: boolean;
			drift: {
				changed: boolean;
				changed_paths: string[];
				baseline_matches_expected?: boolean;
			};
		};
		expect(out.verified).toBe(false); // source no longer returns the cited bytes
		expect(out.drift.baseline_matches_expected).toBe(true); // cited bytes were real
		expect(out.drift.changed).toBe(true);
		expect(out.drift.changed_paths).toContain("af");
	});

	it("exposes a fabricated original whose bytes never hashed to the citation", async () => {
		const realCited = { gene: "TREM2", af: 0.002 };
		const fabricated = { gene: "TREM2", af: 0.9 };
		const H = await sha256Hex(canonicalJson(realCited));
		const res = await callVerify({
			expected_hash: H,
			data: realCited, // source still returns the real bytes
			baseline: fabricated, // the claimed "original" does not
		});
		const out = res.structuredContent?.data as {
			verified: boolean;
			drift: { baseline_matches_expected?: boolean };
		};
		expect(out.verified).toBe(true);
		expect(out.drift.baseline_matches_expected).toBe(false);
	});

	it("carries the baseline hash for downstream re-checking", async () => {
		const baseline = { a: 1 };
		const H = await sha256Hex(canonicalJson({ a: 2 }));
		const baselineHash = await sha256Hex(canonicalJson(baseline));
		const res = await callVerify({
			expected_hash: H,
			data: { a: 2 },
			baseline,
		});
		const out = res.structuredContent?.data as {
			drift: { baseline_hash: string };
		};
		expect(out.drift.baseline_hash).toBe(baselineHash);
	});

	it("still errors when only baseline+data are supplied (no integrity anchor)", async () => {
		const res = await callVerify({ data: { a: 1 }, baseline: { a: 2 } });
		expect(res.isError).toBe(true);
	});
});

describe("verify_citation signature / attestation mode", () => {
	const SIGNED_AT = "2026-07-10T00:00:00.000Z";

	async function signedCitation() {
		const { privateKey, publicKey } = await generateCitationKeypair();
		const cite = await buildCitation({
			source: { id: "ensembl", name: "Ensembl" },
			server: "ensembl",
			tool: "ensembl_execute",
			queryScope: "tool_arguments" as const,
			resultScope: "structured_content:data" as const,
			query: "return await api.get('/lookup/id/ENSG00000095970');",
			result: { gene: "TREM2", id: "ENSG00000095970" },
			retrievedAt: SIGNED_AT,
			recordCount: 1,
		});
		const signed = await signCitation(
			cite,
			{ keyId: "k1", privateKey },
			SIGNED_AT,
		);
		const public_jwk = await exportCitationPublicJwk(publicKey, "k1");
		return { signed, public_jwk };
	}

	async function callVerify(input: Record<string, unknown>) {
		const { register, handlers } = captureRegistrations();
		createVerifyCitationTool().register(register);
		const handler = handlers.get("verify_citation") as unknown as (
			i: Record<string, unknown>,
		) => Promise<{ isError?: boolean; structuredContent?: { data?: unknown } }>;
		return handler(input);
	}

	it("verifies a well-formed signature offline against the published JWK", async () => {
		const { signed, public_jwk } = await signedCitation();
		const res = await callVerify({ citation: signed, public_jwk });
		const out = res.structuredContent?.data as {
			verified: boolean;
			signature_check: { verified: boolean; key_id?: string };
		};
		expect(out.verified).toBe(true);
		expect(out.signature_check.verified).toBe(true);
		expect(out.signature_check.key_id).toBe("k1");
	});

	it("rejects a citation whose result_hash was altered after signing", async () => {
		const { signed, public_jwk } = await signedCitation();
		const forged: Citation = { ...signed, result_hash: "0".repeat(64) };
		const res = await callVerify({ citation: forged, public_jwk });
		const out = res.structuredContent?.data as {
			verified: boolean;
			signature_check: { verified: boolean; reason?: string };
		};
		expect(out.verified).toBe(false);
		expect(out.signature_check.reason).toBe("bad-signature");
	});

	it("reports an unsigned citation as unsigned (not attested)", async () => {
		const { public_jwk } = await signedCitation();
		const cite = await buildCitation({
			source: { id: "ensembl", name: "Ensembl" },
			server: "ensembl",
			tool: "ensembl_execute",
			queryScope: "tool_arguments" as const,
			resultScope: "structured_content:data" as const,
			query: "x",
			result: { a: 1 },
			retrievedAt: SIGNED_AT,
		});
		const res = await callVerify({ citation: cite, public_jwk });
		const out = res.structuredContent?.data as {
			verified: boolean;
			signature_check: { reason?: string };
		};
		expect(out.verified).toBe(false);
		expect(out.signature_check.reason).toBe("unsigned");
	});

	it("treats { citation, public_jwk } alone as a valid call", async () => {
		const { signed, public_jwk } = await signedCitation();
		const res = await callVerify({ citation: signed, public_jwk });
		expect(res.isError).toBeFalsy();
	});

	it("does not throw on a malformed public_jwk", async () => {
		const { signed } = await signedCitation();
		const res = await callVerify({
			citation: signed,
			public_jwk: { bogus: true },
		});
		const out = res.structuredContent?.data as {
			verified: boolean;
			signature_check: { reason?: string };
		};
		expect(out.verified).toBe(false);
		expect(out.signature_check.reason).toBe("malformed");
	});

	it("combines integrity + attestation in one call", async () => {
		const { signed, public_jwk } = await signedCitation();
		const res = await callVerify({
			expected_hash: signed.result_hash,
			data: { gene: "TREM2", id: "ENSG00000095970" },
			citation: signed,
			public_jwk,
		});
		const out = res.structuredContent?.data as {
			verified: boolean;
			expected_hash?: string;
			signature_check: { verified: boolean };
		};
		expect(out.verified).toBe(true);
		expect(out.expected_hash).toBe(signed.result_hash);
		expect(out.signature_check.verified).toBe(true);
	});
});
