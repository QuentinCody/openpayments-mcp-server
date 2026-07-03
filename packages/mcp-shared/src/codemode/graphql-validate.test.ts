import { describe, expect, it } from "vitest";
import type { TrimmedIntrospection } from "./graphql-introspection";
import {
	formatGqlValidationErrors,
	isMutationOperation,
	validateGraphqlQuery,
} from "./graphql-validate";

// A small fixture mirroring the dgidb schema shape from the demo's failing run.
const introspection: TrimmedIntrospection = {
	queryType: { name: "Query" },
	mutationType: { name: "Mutation" },
	types: [
		{
			name: "Query",
			kind: "OBJECT",
			fields: [
				{
					name: "gene",
					type: "Gene",
					args: [{ name: "conceptId", type: "String!" }],
				},
				{
					name: "genes",
					type: "GeneConnection",
					args: [{ name: "names", type: "[String!]" }],
				},
			],
		},
		{
			name: "Gene",
			kind: "OBJECT",
			fields: [
				{ name: "name", type: "String" },
				{ name: "interactions", type: "[Interaction]", args: [] },
			],
		},
		{
			name: "Interaction",
			kind: "OBJECT",
			fields: [
				{ name: "drug", type: "Drug" },
				{ name: "interactionScore", type: "Float" },
			],
		},
		{
			name: "GeneConnection",
			kind: "OBJECT",
			fields: [{ name: "nodes", type: "[Gene]" }],
		},
		{
			name: "Drug",
			kind: "OBJECT",
			fields: [{ name: "name", type: "String" }],
		},
		{
			name: "Mutation",
			kind: "OBJECT",
			fields: [{ name: "noop", type: "Boolean" }],
		},
	],
};

describe("validateGraphqlQuery", () => {
	it("catches the dgidb error class: rejected args, missing required arg, unknown fields", () => {
		const q = `{ gene(name:"EGFR"){ interactions(first:500){ totalCount edges{ node{ name } } } } }`;
		const res = validateGraphqlQuery(q, introspection);
		expect(res.checked).toBe(true);
		const joined = formatGqlValidationErrors(res.errors);
		expect(joined).toContain('does not accept argument "name"');
		expect(joined).toContain('requires argument "conceptId');
		expect(joined).toContain('does not accept argument "first"');
		expect(joined).toContain(
			'"totalCount" does not exist on type "Interaction"',
		);
		expect(joined).toContain('"edges" does not exist on type "Interaction"');
	});

	it("passes a correct query with no errors", () => {
		const q = `{ genes(names:["EGFR"]){ nodes{ name interactions{ interactionScore } } } }`;
		const res = validateGraphqlQuery(q, introspection);
		expect(res.checked).toBe(true);
		expect(res.errors).toEqual([]);
	});

	it("does not choke on string/object/list arg values containing braces", () => {
		const q = `{ gene(conceptId: "a{b}c", extra: { nested: [1,2], s: "x:y)" }){ name } }`;
		const res = validateGraphqlQuery(q, introspection);
		expect(res.checked).toBe(true);
		// 'extra' is not a valid arg on gene → reported; conceptId IS provided so it
		// must NOT be flagged as a missing required argument.
		const joined = formatGqlValidationErrors(res.errors);
		expect(joined).toContain('does not accept argument "extra"');
		expect(joined).not.toContain('requires argument "conceptId');
	});

	it("handles aliases and the `query` keyword + variables", () => {
		const q = `query Q($n: [String!]) { result: genes(names: $n) { nodes { name } } }`;
		const res = validateGraphqlQuery(q, introspection);
		expect(res.checked).toBe(true);
		expect(res.errors).toEqual([]);
	});

	it("bails (checked:false) on a named fragment spread it cannot resolve", () => {
		const q = `{ gene(conceptId:"x") { ...GeneBits } }`;
		const res = validateGraphqlQuery(q, introspection);
		expect(res.checked).toBe(false);
		expect(res.errors).toEqual([]);
	});

	it("bails (checked:false) on unparseable input rather than false-flagging", () => {
		const res = validateGraphqlQuery("this is not graphql {{{", introspection);
		expect(res.checked).toBe(false);
		expect(res.errors).toEqual([]);
	});

	it("routes mutations to the mutation root type", () => {
		const res = validateGraphqlQuery(`mutation { bogusField }`, introspection);
		expect(res.checked).toBe(true);
		expect(formatGqlValidationErrors(res.errors)).toContain(
			'"bogusField" does not exist',
		);
	});

	it("is lenient when the root type is missing from introspection", () => {
		const noMutation: TrimmedIntrospection = {
			queryType: { name: "Query" },
			types: introspection.types,
		};
		const res = validateGraphqlQuery(`mutation { whatever }`, noMutation);
		expect(res.checked).toBe(false);
	});
});

describe("isMutationOperation", () => {
	it("detects a plain mutation operation", () => {
		expect(isMutationOperation("mutation { x }")).toBe(true);
	});

	it("skips leading whitespace and # comments before the keyword", () => {
		expect(isMutationOperation("\n  # a comment\n  mutation Foo { x }")).toBe(
			true,
		);
	});

	it("returns false for queries and anonymous selection sets", () => {
		expect(isMutationOperation("{ x }")).toBe(false);
		expect(isMutationOperation("query { x }")).toBe(false);
		// 'mutationLike' must not be mistaken for the keyword.
		expect(isMutationOperation("mutationLike { x }")).toBe(false);
	});
});
