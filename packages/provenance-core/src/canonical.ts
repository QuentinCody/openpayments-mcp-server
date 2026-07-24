import {
	CANONICALIZATION_PROFILE,
	HASH_ALGORITHM,
} from "./constants";

/**
 * Canonical JSON profile `bio-mcp-json-v1`.
 *
 * Object keys are sorted lexicographically, undefined object members are
 * omitted, array order is retained, and non-JSON primitive values follow
 * JSON.stringify semantics. Cycles are rejected explicitly.
 */
export function canonicalJson(value: unknown): string {
	return canonicalize(value, new Set<object>());
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (ancestors.has(value)) {
		throw new TypeError(
			`${CANONICALIZATION_PROFILE} cannot canonicalize cyclic values`,
		);
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
		}
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, member]) => member !== undefined)
			.sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			);
		return `{${entries
			.map(
				([key, member]) =>
					`${JSON.stringify(key)}:${canonicalize(member, ancestors)}`,
			)
			.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

const HEX = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) {
		output += HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
	}
	return output;
}

/** SHA-256 of a UTF-8 string, lower-case hex encoded. */
export async function sha256Hex(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return bytesToHex(new Uint8Array(digest));
}

/** Hash one JSON value under the declared fleet profile. */
export async function hashCanonicalJson(value: unknown): Promise<string> {
	return sha256Hex(canonicalJson(value));
}

export function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export const HASH_PROFILE = {
	hash_algorithm: HASH_ALGORITHM,
	canonicalization_profile: CANONICALIZATION_PROFILE,
} as const;
