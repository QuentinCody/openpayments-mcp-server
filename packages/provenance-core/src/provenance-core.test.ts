import { describe, expect, it } from "vitest";
import {
	BUILD_GIT_SHA,
	buildCitation,
	buildHealthPayload,
	canonicalJson,
	exportCitationPublicJwk,
	generateCitationKeypair,
	hashCanonicalJson,
	signCitation,
	verifyCitationEnvelope,
} from "./index";

const source = { id: "example", name: "Example Source" };

async function inlineCitation() {
	return buildCitation({
		source,
		server: "example",
		tool: "example_lookup",
		query: { b: 2, a: 1 },
		queryScope: "tool_arguments",
		result: [{ id: 1 }],
		resultScope: "structured_content:data",
		retrievedAt: "2026-07-22T12:00:00.000Z",
	});
}

describe("bio-mcp-json-v1", () => {
	it("sorts object keys, drops undefined members, and retains array order", () => {
		expect(canonicalJson({ z: undefined, b: [2, 1], a: "x" })).toBe(
			'{"a":"x","b":[2,1]}',
		);
	});

	it("rejects cycles instead of producing an unstable digest", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
	});
});

describe("citation scope verification", () => {
	it("emits the complete versioned contract and verifies only declared scopes", async () => {
		const citation = await inlineCitation();
		expect(citation).toMatchObject({
			citation_version: 1,
			hash_algorithm: "sha256",
			canonicalization_profile: "bio-mcp-json-v1",
			query_scope: "tool_arguments",
			result_scope: "structured_content:data",
			issuer_git_sha: BUILD_GIT_SHA,
			fleet_contract_version: "1.0.0",
		});

		const checked = await verifyCitationEnvelope({
			citation,
			toolArguments: { a: 1, b: 2 },
			structuredContent: { data: [{ id: 1 }], unrelated: true },
		});
		expect(checked.verification).toMatchObject({
			status: "verified",
			query: "verified",
			result: "verified",
			signature: "unsigned",
			quarantined: false,
		});
		expect(checked.metrics.verified).toBe(1);
	});

	it("fails closed on a hash mismatch", async () => {
		const citation = await inlineCitation();
		const checked = await verifyCitationEnvelope({
			citation,
			toolArguments: { a: 1, b: 2 },
			structuredContent: { data: [{ id: 2 }] },
		});
		expect(checked.verification).toMatchObject({
			status: "failed",
			reason: "hash_mismatch",
			quarantined: true,
		});
		expect(checked.metrics.mismatch).toBe(1);
	});

	it("keeps staged bytes partial until materialization, then verifies them", async () => {
		const full = [{ id: 1 }, { id: 2 }];
		const citation = await buildCitation({
			source,
			server: "example",
			tool: "example_execute",
			query: "return api.get('/items')",
			queryScope: "tool_argument:code",
			result: full,
			resultScope: "staged:full_result",
			retrievedAt: "2026-07-22T12:00:00.000Z",
			dataAccessId: "example_1",
		});
		const envelope = {
			data: { data_access_id: "example_1" },
			_meta: { staged: true },
		};
		const partial = await verifyCitationEnvelope({
			citation,
			toolArguments: { code: "return api.get('/items')" },
			structuredContent: envelope,
		});
		expect(partial.verification).toMatchObject({
			status: "partial",
			reason: "staged_result_not_materialized",
			quarantined: false,
		});
		expect(partial.metrics.staged_partial).toBe(1);

		const complete = await verifyCitationEnvelope({
			citation,
			toolArguments: { code: "return api.get('/items')" },
			structuredContent: envelope,
			materialized: { value: full },
		});
		expect(complete.verification.status).toBe("verified");
	});

	it("quarantines legacy citations whose scope contract is absent", async () => {
		const citation = await inlineCitation();
		const { query_scope: _scope, ...legacy } = citation;
		const checked = await verifyCitationEnvelope({
			citation: legacy,
			toolArguments: { a: 1, b: 2 },
			structuredContent: { data: [{ id: 1 }] },
		});
		expect(checked.verification.reason).toBe("malformed_citation");
		expect(checked.verification.quarantined).toBe(true);
	});
});

describe("pinned citation authenticity", () => {
	it("accepts a pinned signature and rejects a signature after tampering", async () => {
		const keypair = await generateCitationKeypair();
		const publicJwk = await exportCitationPublicJwk(keypair.publicKey, "key-1");
		const signer = { keyId: "key-1", privateKey: keypair.privateKey };
		const signed = await signCitation(
			await inlineCitation(),
			signer,
			"2026-07-22T12:00:01.000Z",
		);
		const trustStore = {
			version: 1 as const,
			servers: {
				example: { require_signature: true, keys: [publicJwk] },
			},
		};
		const valid = await verifyCitationEnvelope({
			citation: signed,
			toolArguments: { a: 1, b: 2 },
			structuredContent: { data: [{ id: 1 }] },
			trustStore,
		});
		expect(valid.verification.signature).toBe("verified");

		const tampered = { ...signed, tool: "example_other" };
		const invalid = await verifyCitationEnvelope({
			citation: tampered,
			toolArguments: { a: 1, b: 2 },
			structuredContent: { data: [{ id: 1 }] },
			trustStore,
		});
		expect(invalid.verification).toMatchObject({
			status: "failed",
			signature: "bad_signature",
			reason: "signature_failure",
			quarantined: true,
		});
	});

	it("treats a prototype-chain server name as an unknown issuer, not a crash", async () => {
		const base = await inlineCitation();
		const trustStore = { version: 1 as const, servers: {} };
		for (const server of ["__proto__", "constructor", "toString"]) {
			const attack = {
				...base,
				server,
				signature: {
					alg: "Ed25519",
					key_id: "k1",
					signed_at: "2026-07-22T12:00:01.000Z",
					sig: "AAAA",
				},
			};
			const checked = await verifyCitationEnvelope({
				citation: attack,
				toolArguments: { a: 1, b: 2 },
				structuredContent: { data: [{ id: 1 }] },
				trustStore,
			});
			expect(checked.verification).toMatchObject({
				status: "failed",
				signature: "unknown_key",
				reason: "signature_failure",
				quarantined: true,
			});
		}
	});
});

describe("fleet identity", () => {
	it("exposes both required deployment proof fields", () => {
		expect(buildHealthPayload("example")).toEqual({
			status: "ok",
			server: "example",
			git_sha: BUILD_GIT_SHA,
			fleet_contract_version: "1.0.0",
		});
	});

	it("uses the same canonical hash during materialization", async () => {
		expect(await hashCanonicalJson({ b: 2, a: 1 })).toHaveLength(64);
	});
});
