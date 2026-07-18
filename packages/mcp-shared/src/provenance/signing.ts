/**
 * Ed25519 citation signing — the attestation layer (L2) over the reproducible
 * hash (L0) and replay/drift (L1) primitives in `./provenance`.
 *
 * WHY THIS EXISTS. A `result_hash` proves "these bytes hash to H". It does NOT
 * prove the SERVER vouched for them: an agent — or a compromised transport —
 * can present fabricated bytes together with a matching self-computed hash, and
 * a naive re-hash check passes. In an agent pipeline the hash travels alongside
 * the data, so the two are coupled and forgeable together. A signature breaks
 * that coupling: it binds { server, tool, query_hash, result_hash, time } to a
 * private key held ONLY by the issuing server, verifiable OFFLINE against the
 * server's published public key. Only a signed citation is honestly
 * "attested / tamper-evident"; an unsigned one is merely "reproducible".
 *
 * Uses WebCrypto Ed25519 (present in workerd and Node >= 20) — no dependency.
 * Signing is OPT-IN per server: it happens only when a {@link CitationSigner}
 * (an imported private key) is supplied, so every existing unsigned path is
 * unchanged.
 *
 * Rollout (deliberately NOT automatic — minting a signing key and provisioning
 * it as a Worker secret is a credential operation):
 *   1. `scripts/provenance/gen-citation-key.mjs` → prints a private + public JWK.
 *   2. `wrangler secret put CITATION_SIGNING_KEY` (the private JWK) per server.
 *   3. Serve the public JWK at `/.well-known/jwks.json` via {@link buildJwks}.
 *   4. Pass a {@link CitationSigner} into the citation-building path.
 */

import type { Citation, CitationSignature } from "./provenance";
import { canonicalJson } from "./provenance";

export const CITATION_SIG_ALG = "Ed25519" as const;

/** Bumped if the signed-field set ever changes, so verifiers can branch. */
const SIGNING_INPUT_VERSION = 1;

/** A private-key handle for signing citations. */
export interface CitationSigner {
	/** Key id published in the server's JWKS as `kid`. */
	keyId: string;
	/** Imported Ed25519 private CryptoKey (usages: ["sign"]). */
	privateKey: CryptoKey;
}

/** Verdict from checking a citation's signature. */
export interface SignatureVerdict {
	verified: boolean;
	/** Present whenever a signature block existed. */
	key_id?: string;
	/**
	 * Why verification did not pass. Absent when `verified` is true.
	 * - "unsigned": no signature present (reproducible, not attested)
	 * - "bad-signature": crypto rejected it — tampered payload or wrong key
	 * - "malformed": the signature block or public key was unusable
	 */
	reason?: "unsigned" | "bad-signature" | "malformed";
}

/** Minimal JWK shape we read/emit (subset of RFC 7517 / RFC 8037 OKP). */
export interface CitationJwk {
	kty?: string;
	crv?: string;
	x?: string;
	d?: string;
	kid?: string;
	use?: string;
	alg?: string;
	key_ops?: string[];
}

/** A JSON Web Key Set, as served at `/.well-known/jwks.json`. */
export interface Jwks {
	keys: CitationJwk[];
}

// --- base64url (self-contained: no btoa/atob/Buffer, so it types cleanly for
//     both workerd and Node without any DOM/Node lib assumptions) ------------

const B64URL =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP = /* @__PURE__ */ (() => {
	const t = new Int16Array(128).fill(-1);
	for (let i = 0; i < B64URL.length; i++) t[B64URL.charCodeAt(i)] = i;
	return t;
})();

function bytesToBase64url(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
		const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
		out += B64URL[b0 >> 2];
		out += B64URL[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
		if (b1 === undefined) break;
		out += B64URL[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
		if (b2 === undefined) break;
		out += B64URL[b2 & 63];
	}
	return out;
}

function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		const v = code < 128 ? B64URL_LOOKUP[code] : -1;
		if (v < 0) continue;
		buffer = (buffer << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	// Sized allocation → concretely `Uint8Array<ArrayBuffer>`, which the strict
	// build lib requires as a `BufferSource` for crypto.subtle.verify.
	const out = new Uint8Array(bytes.length);
	out.set(bytes);
	return out;
}

// --- signing input ---------------------------------------------------------

/**
 * The canonical byte string that gets signed. Covers exactly the
 * attestation-critical fields — WHO issued it (`server`), WHICH tool, WHEN,
 * WHAT was asked (`query_hash`), WHAT came back (`result_hash`), and the
 * negative-result status. Deliberately excludes `text` (a human convenience)
 * and `data_access_id` (an ephemeral per-session handle). Versioned so a future
 * field-set change is detectable rather than silently incompatible.
 */
export function citationSigningInput(
	citation: Citation,
	signedAt: string,
): string {
	return canonicalJson({
		v: SIGNING_INPUT_VERSION,
		server: citation.server,
		tool: citation.tool,
		source_id: citation.source.id,
		retrieved_at: citation.retrieved_at,
		signed_at: signedAt,
		query_hash: citation.query_hash,
		result_hash: citation.result_hash,
		record_count: citation.record_count ?? null,
		negative_result: citation.negative_result ?? false,
		verification: citation.verification ?? null,
	});
}

// --- sign / verify ---------------------------------------------------------

/**
 * Attach an Ed25519 signature to a citation. Returns a NEW citation with
 * `signature` set; the input is not mutated. `signedAt` is caller-supplied
 * (DO/Worker: `new Date().toISOString()`), and is itself part of the signed
 * payload so it cannot be altered after the fact.
 */
export async function signCitation(
	citation: Citation,
	signer: CitationSigner,
	signedAt: string,
): Promise<Citation> {
	const input = new TextEncoder().encode(
		citationSigningInput(citation, signedAt),
	);
	const raw = await crypto.subtle.sign(
		{ name: CITATION_SIG_ALG },
		signer.privateKey,
		input,
	);
	const signature: CitationSignature = {
		alg: CITATION_SIG_ALG,
		key_id: signer.keyId,
		signed_at: signedAt,
		sig: bytesToBase64url(new Uint8Array(raw)),
	};
	return { ...citation, signature };
}

/**
 * Verify a citation's embedded signature against a public key. The caller is
 * responsible for obtaining that key from the issuing server's published JWKS
 * (matching `signature.key_id`) — this function only performs the crypto, which
 * is what makes it usable offline by any consumer.
 */
export async function verifyCitationSignature(
	citation: Citation,
	publicKey: CryptoKey,
): Promise<SignatureVerdict> {
	const sig = citation.signature;
	if (!sig) return { verified: false, reason: "unsigned" };
	if (
		sig.alg !== CITATION_SIG_ALG ||
		typeof sig.sig !== "string" ||
		typeof sig.signed_at !== "string" ||
		sig.signed_at.length === 0
	) {
		return { verified: false, key_id: sig.key_id, reason: "malformed" };
	}
	try {
		const input = new TextEncoder().encode(
			citationSigningInput(citation, sig.signed_at),
		);
		const ok = await crypto.subtle.verify(
			{ name: CITATION_SIG_ALG },
			publicKey,
			base64urlToBytes(sig.sig),
			input,
		);
		return ok
			? { verified: true, key_id: sig.key_id }
			: { verified: false, key_id: sig.key_id, reason: "bad-signature" };
	} catch {
		return { verified: false, key_id: sig.key_id, reason: "malformed" };
	}
}

// --- key material ----------------------------------------------------------

/** Keep only the fields WebCrypto needs, dropping `alg`/`use`/`key_ops` that
 *  can conflict with the requested key usages on import. */
function coreJwk(jwk: CitationJwk): CitationJwk {
	return jwk.d !== undefined
		? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }
		: { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

/** Generate a fresh extractable Ed25519 keypair. */
export async function generateCitationKeypair(): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey({ name: CITATION_SIG_ALG }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
}

/** Import a private JWK (must contain `d`) for signing. */
export async function importCitationPrivateKey(
	jwk: CitationJwk,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"jwk",
		coreJwk(jwk) as JsonWebKey,
		{ name: CITATION_SIG_ALG },
		false,
		["sign"],
	);
}

/** Import a public JWK for verification. */
export async function importCitationPublicKey(
	jwk: CitationJwk,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"jwk",
		coreJwk(jwk) as JsonWebKey,
		{ name: CITATION_SIG_ALG },
		true,
		["verify"],
	);
}

/** Export a public key as a JWKS-ready JWK, stamped with `kid`. */
export async function exportCitationPublicJwk(
	publicKey: CryptoKey,
	keyId: string,
): Promise<CitationJwk> {
	const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as CitationJwk;
	return {
		kty: jwk.kty,
		crv: jwk.crv,
		x: jwk.x,
		kid: keyId,
		use: "sig",
		alg: "EdDSA",
		key_ops: ["verify"],
	};
}

/** Wrap one or more public JWKs into a JWKS document. */
export function buildJwks(publicJwks: CitationJwk[]): Jwks {
	return { keys: publicJwks };
}
