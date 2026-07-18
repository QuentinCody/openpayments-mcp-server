import { describe, expect, it } from "vitest";
import { buildCitation, type Citation } from "./provenance";
import {
	buildJwks,
	CITATION_SIG_ALG,
	citationSigningInput,
	exportCitationPublicJwk,
	generateCitationKeypair,
	importCitationPrivateKey,
	importCitationPublicKey,
	signCitation,
	verifyCitationSignature,
} from "./signing";

const SIGNED_AT = "2026-07-10T00:00:00.000Z";

async function sampleCitation(): Promise<Citation> {
	return buildCitation({
		source: { id: "ensembl", name: "Ensembl" },
		server: "ensembl",
		tool: "ensembl_execute",
		query: "return await api.get('/lookup/id/ENSG00000095970');",
		result: { gene: "TREM2", id: "ENSG00000095970", biotype: "protein_coding" },
		retrievedAt: SIGNED_AT,
		recordCount: 1,
	});
}

describe("citation signing (Ed25519, L2)", () => {
	it("signs and verifies a citation round-trip", async () => {
		const { privateKey, publicKey } = await generateCitationKeypair();
		const cite = await sampleCitation();
		const signed = await signCitation(cite, { keyId: "k1", privateKey }, SIGNED_AT);

		expect(signed.signature).toBeDefined();
		expect(signed.signature?.alg).toBe(CITATION_SIG_ALG);
		expect(signed.signature?.key_id).toBe("k1");
		expect(signed.signature?.signed_at).toBe(SIGNED_AT);

		const verdict = await verifyCitationSignature(signed, publicKey);
		expect(verdict.verified).toBe(true);
		expect(verdict.key_id).toBe("k1");
		expect(verdict.reason).toBeUndefined();
	});

	it("does not mutate the input citation", async () => {
		const { privateKey } = await generateCitationKeypair();
		const cite = await sampleCitation();
		await signCitation(cite, { keyId: "k1", privateKey }, SIGNED_AT);
		expect(cite.signature).toBeUndefined();
	});

	it("rejects a tampered result_hash", async () => {
		const { privateKey, publicKey } = await generateCitationKeypair();
		const signed = await signCitation(
			await sampleCitation(),
			{ keyId: "k1", privateKey },
			SIGNED_AT,
		);
		const forged: Citation = { ...signed, result_hash: `${"0".repeat(64)}` };
		const verdict = await verifyCitationSignature(forged, publicKey);
		expect(verdict.verified).toBe(false);
		expect(verdict.reason).toBe("bad-signature");
	});

	it("rejects a tampered query_hash", async () => {
		const { privateKey, publicKey } = await generateCitationKeypair();
		const signed = await signCitation(
			await sampleCitation(),
			{ keyId: "k1", privateKey },
			SIGNED_AT,
		);
		const forged: Citation = { ...signed, query_hash: "deadbeef" };
		expect((await verifyCitationSignature(forged, publicKey)).verified).toBe(
			false,
		);
	});

	it("rejects a moved signed_at (freshness cannot be back-dated)", async () => {
		const { privateKey, publicKey } = await generateCitationKeypair();
		const signed = await signCitation(
			await sampleCitation(),
			{ keyId: "k1", privateKey },
			SIGNED_AT,
		);
		const forged: Citation = {
			...signed,
			// biome-ignore lint/style/noNonNullAssertion: signed above
			signature: { ...signed.signature!, signed_at: "2020-01-01T00:00:00.000Z" },
		};
		expect((await verifyCitationSignature(forged, publicKey)).verified).toBe(
			false,
		);
	});

	it("rejects a signature made by a different key", async () => {
		const a = await generateCitationKeypair();
		const b = await generateCitationKeypair();
		const signed = await signCitation(
			await sampleCitation(),
			{ keyId: "k1", privateKey: a.privateKey },
			SIGNED_AT,
		);
		// verify against the WRONG public key
		const verdict = await verifyCitationSignature(signed, b.publicKey);
		expect(verdict.verified).toBe(false);
		expect(verdict.reason).toBe("bad-signature");
	});

	it("reports an unsigned citation as unsigned, not tampered", async () => {
		const { publicKey } = await generateCitationKeypair();
		const verdict = await verifyCitationSignature(await sampleCitation(), publicKey);
		expect(verdict.verified).toBe(false);
		expect(verdict.reason).toBe("unsigned");
	});

	it("verifies through a JWKS export/import round-trip (offline consumer path)", async () => {
		const { privateKey, publicKey } = await generateCitationKeypair();
		const signed = await signCitation(
			await sampleCitation(),
			{ keyId: "kid-2026", privateKey },
			SIGNED_AT,
		);

		// Server side: publish the public key.
		const pubJwk = await exportCitationPublicJwk(publicKey, "kid-2026");
		const jwks = buildJwks([pubJwk]);
		expect(jwks.keys[0].kid).toBe("kid-2026");
		expect(jwks.keys[0].use).toBe("sig");
		expect(jwks.keys[0].d).toBeUndefined(); // never leak the private scalar

		// Consumer side: re-import from the JWKS and verify.
		const imported = await importCitationPublicKey(jwks.keys[0]);
		expect((await verifyCitationSignature(signed, imported)).verified).toBe(true);
	});

	it("signs with a key imported from a private JWK (the secret-store path)", async () => {
		const { privateKey, publicKey } = await generateCitationKeypair();
		const privJwk = (await crypto.subtle.exportKey(
			"jwk",
			privateKey,
		)) as Record<string, unknown>;
		const reimported = await importCitationPrivateKey(privJwk);
		const signed = await signCitation(
			await sampleCitation(),
			{ keyId: "k1", privateKey: reimported },
			SIGNED_AT,
		);
		expect((await verifyCitationSignature(signed, publicKey)).verified).toBe(true);
	});

	it("produces a deterministic, canonical signing input", async () => {
		const cite = await sampleCitation();
		const a = citationSigningInput(cite, SIGNED_AT);
		const b = citationSigningInput({ ...cite }, SIGNED_AT);
		expect(a).toBe(b);
		expect(a).toContain('"result_hash"');
		expect(a).toContain('"query_hash"');
		expect(a).not.toContain('"text"'); // human text is not part of the attestation
	});
});
