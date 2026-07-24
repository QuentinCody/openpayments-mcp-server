import { afterEach, describe, expect, it } from "vitest";
import {
	buildCitation,
	clearCitationSigningConfiguration,
	configureCitationSigning,
} from "./provenance";
import {
	generateCitationKeypair,
	verifyCitationSignature,
} from "./signing";

afterEach(() => clearCitationSigningConfiguration());

const citationInput = {
	source: { id: "example", name: "Example" },
	server: "example",
	tool: "example_lookup",
	query: { id: "1" },
	queryScope: "tool_arguments" as const,
	result: { value: 1 },
	resultScope: "structured_content:data" as const,
	retrievedAt: "2026-07-22T12:00:00.000Z",
};

describe("Worker citation issuer signing", () => {
	it("stays unsigned when no private-key secret is configured", async () => {
		expect((await buildCitation(citationInput)).signature).toBeUndefined();
	});

	it("signs with an environment private JWK and verifies offline", async () => {
		const keypair = await generateCitationKeypair();
		const privateJwk = await crypto.subtle.exportKey("jwk", keypair.privateKey);
		configureCitationSigning({
			CITATION_SIGNING_PRIVATE_JWK: JSON.stringify({
				...privateJwk,
				kid: "example-2026-01",
			}),
		});
		const citation = await buildCitation(citationInput);
		expect(citation.signature?.key_id).toBe("example-2026-01");
		expect(
			(await verifyCitationSignature(citation, keypair.publicKey)).verified,
		).toBe(true);
	});

	it("accepts the legacy private-key secret name during migration", async () => {
		const keypair = await generateCitationKeypair();
		const privateJwk = await crypto.subtle.exportKey("jwk", keypair.privateKey);
		configureCitationSigning({
			CITATION_SIGNING_KEY: JSON.stringify({
				...privateJwk,
				kid: "legacy-example-2026-01",
			}),
		});
		const citation = await buildCitation(citationInput);
		expect(citation.signature?.key_id).toBe("legacy-example-2026-01");
		expect(
			(await verifyCitationSignature(citation, keypair.publicKey)).verified,
		).toBe(true);
	});

	it("fails closed when a configured secret is malformed", () => {
		expect(() =>
			configureCitationSigning({ CITATION_SIGNING_PRIVATE_JWK: "not-json" }),
		).toThrow(/not valid JSON/);
	});
});
