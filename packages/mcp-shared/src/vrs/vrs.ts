/**
 * GA4GH VRS computed identifiers (`ga4gh:VA.…`, `ga4gh:SL.…`).
 *
 * A VRS computed identifier is a deterministic digest of a normalized variant:
 * no API call, no network, no registry. Two servers that describe the same
 * variant produce the same identifier, which is what makes cross-server joins
 * (clinvar / gnomad / civic / eva) keyable instead of HGVS string-matching.
 *
 * Why a private serializer instead of `canonicalJson` from provenance-core:
 * VRS identifiers are an external contract with the wider genomics ecosystem —
 * the bytes are fixed by the GA4GH spec forever. provenance-core's
 * canonicalizer serves the citation-hash contract and is free to evolve for
 * that purpose; coupling the two would let a citation-side change silently
 * invalidate every VRS identifier we have ever emitted. The two must be able
 * to move independently.
 *
 * Serialization is the RFC 8785 (JCS) subset VRS requires: UTF-8, keys sorted
 * by code unit, no insignificant whitespace, null-valued fields excluded, and
 * nested *identifiable* objects replaced by their bare digest.
 *
 * Pinned by the byte-exact vectors in `vrs.test.ts`, taken from the reference
 * implementation (ga4gh/vrs-python `tests/test_vrs.py`).
 */

/** Type prefixes for the identifiable VRS classes this module emits. */
export const VRS_TYPE_PREFIX = {
	Allele: "VA",
	SequenceLocation: "SL",
} as const;

/** A refget accession is a bare `SQ.<32-char digest>` — never `ga4gh:`-prefixed. */
const REFGET_ACCESSION_RE = /^SQ\.[A-Za-z0-9_-]{32}$/;

/** sha512t24u digests are 24 bytes → exactly 32 base64url characters. */
const DIGEST_LENGTH = 32;
const TRUNCATED_DIGEST_BYTES = 24;

export interface SequenceReference {
	type: "SequenceReference";
	refgetAccession: string;
}

export interface SequenceLocation {
	type: "SequenceLocation";
	sequenceReference: SequenceReference;
	/** Interbase (0-based, half-open) start coordinate. */
	start: number;
	/** Interbase (0-based, half-open) end coordinate. */
	end: number;
}

export interface LiteralSequenceExpression {
	type: "LiteralSequenceExpression";
	/** The replacement sequence; empty string for a deletion. */
	sequence: string;
}

export interface Allele {
	type: "Allele";
	location: SequenceLocation;
	state: LiteralSequenceExpression;
}

/** Thrown when an input cannot produce a spec-valid identifier. */
export class VrsError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "VrsError";
		this.code = code;
	}
}

function base64UrlNoPad(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * The GA4GH truncated digest: SHA-512, left-truncated to 24 bytes, base64url.
 *
 * Spec test vector: `sha512t24u("ACGT") === "aKF498dAxcJAqme6QYQ7EZ07-fiw8Kw2"`.
 */
export async function sha512t24u(blob: string | Uint8Array): Promise<string> {
	const bytes =
		typeof blob === "string" ? new TextEncoder().encode(blob) : blob;
	// SAFETY: BufferSource accepts Uint8Array; the cast only satisfies the DOM
	// lib's ArrayBufferView union, which does not narrow to Uint8Array directly.
	const hashed = await crypto.subtle.digest("SHA-512", bytes as BufferSource);
	return base64UrlNoPad(
		new Uint8Array(hashed).subarray(0, TRUNCATED_DIGEST_BYTES),
	);
}

/**
 * RFC 8785 key ordering: sort by UTF-16 code unit, which for the ASCII keys
 * VRS defines is a plain lexicographic sort.
 */
function jcsSerialize(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new VrsError(
				"NON_FINITE_NUMBER",
				"Cannot serialize a non-finite number.",
			);
		}
		return JSON.stringify(value);
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	if (Array.isArray(value)) {
		return `[${value.map(jcsSerialize).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entryValue]) => entryValue !== null && entryValue !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	const body = entries
		.map(
			([key, entryValue]) =>
				`${JSON.stringify(key)}:${jcsSerialize(entryValue)}`,
		)
		.join(",");
	return `{${body}}`;
}

function assertRefgetAccession(accession: string): void {
	if (accession.startsWith("ga4gh:")) {
		throw new VrsError(
			"NAMESPACED_REFGET_ACCESSION",
			`refgetAccession must not carry a namespace prefix: ${accession}`,
		);
	}
	if (!REFGET_ACCESSION_RE.test(accession)) {
		throw new VrsError(
			"INVALID_REFGET_ACCESSION",
			`refgetAccession must look like SQ.<32 base64url chars>: ${accession}`,
		);
	}
}

function assertLocation(location: SequenceLocation): void {
	assertRefgetAccession(location.sequenceReference.refgetAccession);
	if (!Number.isInteger(location.start) || !Number.isInteger(location.end)) {
		throw new VrsError(
			"NON_INTEGER_COORDINATE",
			"start and end must be integers.",
		);
	}
	if (location.start < 0) {
		throw new VrsError("NEGATIVE_COORDINATE", "start must be >= 0.");
	}
	if (location.end < location.start) {
		throw new VrsError("INVERTED_INTERVAL", "end must be >= start.");
	}
}

/**
 * A SequenceReference is not identifiable — it is expanded inline wherever it
 * appears rather than replaced by a digest.
 */
export function serializeSequenceReference(
	reference: SequenceReference,
): string {
	assertRefgetAccession(reference.refgetAccession);
	return jcsSerialize({
		refgetAccession: reference.refgetAccession,
		type: "SequenceReference",
	});
}

export function serializeSequenceLocation(location: SequenceLocation): string {
	assertLocation(location);
	return jcsSerialize({
		end: location.end,
		sequenceReference: {
			refgetAccession: location.sequenceReference.refgetAccession,
			type: "SequenceReference",
		},
		start: location.start,
		type: "SequenceLocation",
	});
}

export async function sequenceLocationDigest(
	location: SequenceLocation,
): Promise<string> {
	return sha512t24u(serializeSequenceLocation(location));
}

export async function sequenceLocationId(
	location: SequenceLocation,
): Promise<string> {
	return `ga4gh:${VRS_TYPE_PREFIX.SequenceLocation}.${await sequenceLocationDigest(location)}`;
}

/**
 * An Allele's nested SequenceLocation *is* identifiable, so it is replaced by
 * its bare digest (no `ga4gh:SL.` prefix) before the Allele is digested.
 */
export async function serializeAllele(allele: Allele): Promise<string> {
	const locationDigest = await sequenceLocationDigest(allele.location);
	return jcsSerialize({
		location: locationDigest,
		state: {
			sequence: allele.state.sequence,
			type: "LiteralSequenceExpression",
		},
		type: "Allele",
	});
}

export async function alleleDigest(allele: Allele): Promise<string> {
	return sha512t24u(await serializeAllele(allele));
}

/** The full CURIE, e.g. `ga4gh:VA.Hy2XU_-rp4IMh6I_1NXNecBo8Qx8n0oE`. */
export async function alleleId(allele: Allele): Promise<string> {
	return `ga4gh:${VRS_TYPE_PREFIX.Allele}.${await alleleDigest(allele)}`;
}

/** True for a syntactically well-formed VRS Allele or SequenceLocation CURIE. */
export function isVrsId(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = /^ga4gh:(VA|SL)\.([A-Za-z0-9_-]+)$/.exec(value);
	return match !== null && match[2].length === DIGEST_LENGTH;
}

export interface AlleleFromCoordsInput {
	refgetAccession: string;
	/** Interbase (0-based, half-open) start. */
	start: number;
	/** Interbase (0-based, half-open) end. */
	end: number;
	/** Replacement sequence; empty string for a deletion. */
	alt: string;
}

/** Build an Allele from interbase coordinates without touching the network. */
export function alleleFromCoords(input: AlleleFromCoordsInput): Allele {
	const allele: Allele = {
		type: "Allele",
		location: {
			type: "SequenceLocation",
			sequenceReference: {
				type: "SequenceReference",
				refgetAccession: input.refgetAccession,
			},
			start: input.start,
			end: input.end,
		},
		state: {
			type: "LiteralSequenceExpression",
			sequence: input.alt.toUpperCase(),
		},
	};
	assertLocation(allele.location);
	return allele;
}

/**
 * Build an Allele from the 1-based VCF-style coordinates every one of our
 * upstream sources speaks, converting to VRS interbase on the way in.
 */
export function alleleFromVcf(input: {
	refgetAccession: string;
	/** 1-based position of the first base of `ref`. */
	position: number;
	ref: string;
	alt: string;
}): Allele {
	if (!Number.isInteger(input.position) || input.position < 1) {
		throw new VrsError(
			"INVALID_VCF_POSITION",
			"VCF position must be a 1-based integer.",
		);
	}
	const start = input.position - 1;
	return alleleFromCoords({
		refgetAccession: input.refgetAccession,
		start,
		end: start + input.ref.length,
		alt: input.alt,
	});
}

/**
 * Derive the refget accession for a literal sequence.
 *
 * A refget accession is just the sha512t24u of the upper-cased residues, so a
 * caller holding the sequence can compute it offline. Whole chromosomes are
 * far too large to pass through here — for those, take the published accession
 * from a refget service. This is for the short references our servers actually
 * hold in hand (transcripts, peptides, contigs, test fixtures).
 */
export async function refgetAccessionForSequence(
	sequence: string,
): Promise<string> {
	if (sequence.length === 0) {
		throw new VrsError(
			"EMPTY_SEQUENCE",
			"Cannot derive a refget accession for an empty sequence.",
		);
	}
	return `SQ.${await sha512t24u(sequence.toUpperCase())}`;
}
