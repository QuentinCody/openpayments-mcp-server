/**
 * Verify-citation tool factory — a shared MCP tool that re-checks the integrity
 * anchor of a previously-issued citation.
 *
 * A {@link Citation} (see `../provenance/provenance`) carries
 * `result_hash = sha256(canonicalJson(result))`. This tool recomputes that hash
 * from data the caller (re-)supplies and reports whether it matches — letting an
 * agent prove that cited bytes were not altered, using the SAME canonicalization
 * + sha256 that produced the citation.
 *
 * Registered under two names (`verify_citation` + `mcp_verify_citation`) to match
 * the repo's dual-registration convention for discoverability across clients.
 */

import { z } from "zod";
import { verifyResultHash } from "../provenance/provenance";
import { createCodeModeError, createCodeModeResponse, ErrorCodes } from "./response";

/** The Zod input schema for the verify-citation tool. */
export interface VerifyCitationSchema {
	expected_hash: z.ZodString;
	data: z.ZodUnknown;
}

export interface VerifyCitationToolResult {
	/** Primary registered tool name. */
	name: string;
	/** Human/agent-readable description. */
	description: string;
	/** Zod input schema (raw shape passed to `server.tool`). */
	schema: VerifyCitationSchema;
	/** Register the tool (and its `mcp_` alias) on an MCP server. */
	register: (server: { tool: (...args: unknown[]) => void }) => void;
}

const TOOL_NAME = "verify_citation";
const ALIAS_NAME = "mcp_verify_citation";

const DESCRIPTION =
	"Verify a citation's integrity anchor: recompute sha256(canonicalJson(data)) " +
	"and confirm it matches a previously-issued result_hash. Returns " +
	"{ verified, expected_hash, actual_hash }. Use this to prove that data cited " +
	"by an earlier tool result (its `result_hash`) was not altered. A mismatch is " +
	"a normal negative verdict (verified:false), not a tool error.";

/**
 * Create a registerable `verify_citation` tool.
 *
 * Input: `{ expected_hash: string, data: <arbitrary JSON> }`.
 * Output (structuredContent.data): `{ verified, expected_hash, actual_hash }`.
 */
export function createVerifyCitationTool(): VerifyCitationToolResult {
	const schema: VerifyCitationSchema = {
		expected_hash: z
			.string()
			.describe(
				"The previously-issued result_hash (hex sha256) to verify against — " +
					"e.g. a Citation.result_hash.",
			),
		data: z
			.unknown()
			.describe(
				"The (claimed) underlying result data to re-hash. Any JSON value; " +
					"key order does not matter (canonicalized before hashing).",
			),
	};

	async function handle(input: { expected_hash: string; data: unknown }) {
		const expectedHash = input?.expected_hash;
		if (typeof expectedHash !== "string" || expectedHash.length === 0) {
			return createCodeModeError(
				ErrorCodes.INVALID_ARGUMENTS,
				"expected_hash is required and must be a non-empty hex string",
			);
		}

		const { verified, expected_hash, actual_hash } = await verifyResultHash(
			expectedHash,
			input.data,
		);

		const textSummary = verified
			? `Verified: data matches the cited result_hash (sha256:${actual_hash.slice(0, 12)}).`
			: `NOT verified: hash mismatch. expected sha256:${expected_hash.slice(0, 12)}, ` +
				`got sha256:${actual_hash.slice(0, 12)}. The cited data does not match.`;

		return createCodeModeResponse({ verified, expected_hash, actual_hash }, { textSummary });
	}

	return {
		name: TOOL_NAME,
		description: DESCRIPTION,
		schema,
		register(server: { tool: (...args: unknown[]) => void }) {
			// Return handle()'s promise directly (no async wrapper) — the MCP SDK
			// awaits the handler, so the promise is consumed, not floating.
			const toolHandler = (input: { expected_hash: string; data: unknown }) => handle(input);
			for (const name of [TOOL_NAME, ALIAS_NAME]) {
				server.tool(name, DESCRIPTION, schema, toolHandler);
			}
		},
	};
}
