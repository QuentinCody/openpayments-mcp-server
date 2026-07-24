import { canonicalJson } from "./canonical";
import type {
	Citation,
	CitationJwk,
	CitationSignature,
	Jwks,
} from "./types";

export const CITATION_SIG_ALG = "Ed25519" as const;
const SIGNING_INPUT_VERSION = 2;

export interface CitationSigner {
	keyId: string;
	privateKey: CryptoKey;
}

export interface SignatureVerdict {
	verified: boolean;
	key_id?: string;
	reason?: "unsigned" | "bad-signature" | "malformed";
}

const B64URL =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP = (() => {
	const table = new Int16Array(128).fill(-1);
	for (let index = 0; index < B64URL.length; index++) {
		table[B64URL.charCodeAt(index)] = index;
	}
	return table;
})();

function bytesToBase64url(bytes: Uint8Array): string {
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index];
		const second = index + 1 < bytes.length ? bytes[index + 1] : undefined;
		const third = index + 2 < bytes.length ? bytes[index + 2] : undefined;
		output += B64URL[first >> 2];
		output += B64URL[((first & 3) << 4) | ((second ?? 0) >> 4)];
		if (second === undefined) break;
		output += B64URL[((second & 15) << 2) | ((third ?? 0) >> 6)];
		if (third === undefined) break;
		output += B64URL[third & 63];
	}
	return output;
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new TypeError("invalid base64url value");
	}
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const character of value) {
		const code = character.charCodeAt(0);
		const decoded = code < 128 ? B64URL_LOOKUP[code] : -1;
		if (decoded < 0) throw new TypeError("invalid base64url value");
		buffer = (buffer << 6) | decoded;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	const output = new Uint8Array(bytes.length);
	output.set(bytes);
	return output;
}

/** Canonical version-two attestation input. */
export function citationSigningInput(
	citation: Citation,
	signedAt: string,
): string {
	return canonicalJson({
		v: SIGNING_INPUT_VERSION,
		citation_version: citation.citation_version,
		hash_algorithm: citation.hash_algorithm,
		canonicalization_profile: citation.canonicalization_profile,
		query_scope: citation.query_scope,
		result_scope: citation.result_scope,
		server: citation.server,
		tool: citation.tool,
		source_id: citation.source.id,
		retrieved_at: citation.retrieved_at,
		signed_at: signedAt,
		query_hash: citation.query_hash,
		result_hash: citation.result_hash,
		issuer_git_sha: citation.issuer_git_sha,
		fleet_contract_version: citation.fleet_contract_version,
		record_count: citation.record_count ?? null,
		negative_result: citation.negative_result ?? false,
		verification: citation.verification ?? null,
	});
}

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

export async function verifyCitationSignature(
	citation: Citation,
	publicKey: CryptoKey,
): Promise<SignatureVerdict> {
	const signature = citation.signature;
	if (!signature) return { verified: false, reason: "unsigned" };
	if (
		signature.alg !== CITATION_SIG_ALG ||
		typeof signature.key_id !== "string" ||
		signature.key_id.length === 0 ||
		typeof signature.signed_at !== "string" ||
		signature.signed_at.length === 0 ||
		typeof signature.sig !== "string"
	) {
		return {
			verified: false,
			key_id: signature.key_id,
			reason: "malformed",
		};
	}
	try {
		const verified = await crypto.subtle.verify(
			{ name: CITATION_SIG_ALG },
			publicKey,
			base64urlToBytes(signature.sig),
			new TextEncoder().encode(
				citationSigningInput(citation, signature.signed_at),
			),
		);
		return verified
			? { verified: true, key_id: signature.key_id }
			: {
					verified: false,
					key_id: signature.key_id,
					reason: "bad-signature",
				};
	} catch {
		return {
			verified: false,
			key_id: signature.key_id,
			reason: "malformed",
		};
	}
}

function coreJwk(jwk: CitationJwk): JsonWebKey {
	return (jwk.d !== undefined
		? { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }
		: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }) as JsonWebKey;
}

export async function generateCitationKeypair(): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey({ name: CITATION_SIG_ALG }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
}

export async function importCitationPrivateKey(
	jwk: CitationJwk,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"jwk",
		coreJwk(jwk),
		{ name: CITATION_SIG_ALG },
		false,
		["sign"],
	);
}

export async function importCitationPublicKey(
	jwk: CitationJwk,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"jwk",
		coreJwk(jwk),
		{ name: CITATION_SIG_ALG },
		true,
		["verify"],
	);
}

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

export function buildJwks(publicJwks: CitationJwk[]): Jwks {
	return { keys: publicJwks };
}
