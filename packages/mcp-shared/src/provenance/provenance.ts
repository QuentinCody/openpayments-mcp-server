/**
 * Fleet issuer facade over the runtime-neutral provenance core.
 *
 * Hashing and verification stay in provenance-core. This layer adds optional
 * Worker-secret-backed signing without making secret access part of the core.
 */
import {
	buildCitation as buildUnsignedCitation,
	importCitationPrivateKey,
	signCitation,
	type BuildCitationInput,
	type Citation,
	type CitationJwk,
	type CitationSigner,
} from "@bio-mcp/provenance-core";

export {
	canonicalJson,
	hashCanonicalJson,
	sha256Hex,
	verifyCitation,
	verifyResultHash,
} from "@bio-mcp/provenance-core";

export type {
	BuildCitationInput,
	Citation,
	CitationSignature,
	QueryScope,
	ResultScope,
	SourceDescriptor,
	VerifyResult,
} from "@bio-mcp/provenance-core";

interface SigningConfiguration {
	privateJwk: CitationJwk;
	keyId: string;
}

let signingConfiguration: SigningConfiguration | undefined;
let signerPromise: Promise<CitationSigner> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePrivateJwk(value: string): CitationJwk {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("CITATION_SIGNING_PRIVATE_JWK is not valid JSON");
	}
	if (
		!isRecord(parsed) ||
		parsed.kty !== "OKP" ||
		parsed.crv !== "Ed25519" ||
		typeof parsed.x !== "string" ||
		typeof parsed.d !== "string"
	) {
		throw new Error("CITATION_SIGNING_PRIVATE_JWK is not an Ed25519 private JWK");
	}
	return {
		kty: parsed.kty,
		crv: parsed.crv,
		x: parsed.x,
		d: parsed.d,
		...(typeof parsed.kid === "string" ? { kid: parsed.kid } : {}),
	};
}

/**
 * Load an optional private citation key from a Worker's environment bindings.
 * A configured-but-malformed secret throws so the issuer never silently
 * downgrades from signed to unsigned citations.
 */
export function configureCitationSigning(environment: unknown): void {
	if (!isRecord(environment)) return;
	const raw = environment.CITATION_SIGNING_PRIVATE_JWK ?? environment.CITATION_SIGNING_KEY;
	if (raw === undefined) return;
	if (typeof raw !== "string") {
		throw new Error("CITATION_SIGNING_PRIVATE_JWK must be a JSON string");
	}
	const privateJwk = parsePrivateJwk(raw);
	const configuredKeyId = environment.CITATION_SIGNING_KEY_ID;
	const keyId =
		typeof configuredKeyId === "string" ? configuredKeyId : privateJwk.kid;
	if (!keyId) throw new Error("CITATION_SIGNING_KEY_ID or private JWK kid is required");
	const changed =
		signingConfiguration?.keyId !== keyId ||
		JSON.stringify(signingConfiguration.privateJwk) !== JSON.stringify(privateJwk);
	if (changed) signerPromise = undefined;
	signingConfiguration = { privateJwk, keyId };
}

export function clearCitationSigningConfiguration(): void {
	signingConfiguration = undefined;
	signerPromise = undefined;
}

async function configuredSigner(): Promise<CitationSigner | undefined> {
	if (!signingConfiguration) return undefined;
	signerPromise ??= importCitationPrivateKey(signingConfiguration.privateJwk).then(
		(privateKey) => ({
			privateKey,
			keyId: signingConfiguration?.keyId ?? "",
		}),
	);
	return signerPromise;
}

export async function buildCitation(
	input: BuildCitationInput,
): Promise<Citation> {
	const citation = await buildUnsignedCitation(input);
	const signer = await configuredSigner();
	return signer
		? signCitation(citation, signer, input.retrievedAt)
		: citation;
}
