import { describe, expect, it } from "vitest";
import { ols4Search, ols4TermDescendants } from "./efo_ols4.js";

describe("efo_ols4 adapter", () => {
	it("ols4Search builds an EFO search URL", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ response: { docs: [] } }), { status: 200 });
		};
		await ols4Search("type 2 diabetes", { fetchImpl: f });
		expect(captured[0]).toContain("/ols4/api/search");
		expect(captured[0]).toContain("ontology=efo");
		expect(captured[0]).toContain("q=type+2+diabetes");
	});

	it("ols4TermDescendants double-encodes IRI", async () => {
		const captured: string[] = [];
		const f: typeof fetch = async (input) => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return new Response(JSON.stringify({ _embedded: { terms: [] } }), { status: 200 });
		};
		await ols4TermDescendants("efo", "http://www.ebi.ac.uk/efo/EFO_0001360", { fetchImpl: f });
		expect(captured[0]).toContain("/descendants");
	});
});
