import { describe, it, expect } from "vitest";
import { buildGraphqlProxySource } from "./graphql-proxy";

describe("buildGraphqlProxySource", () => {
	const source = buildGraphqlProxySource();

	it("returns a non-empty string", () => {
		expect(typeof source).toBe("string");
		expect(source.length).toBeGreaterThan(0);
	});

	it("declares the gql object", () => {
		expect(source).toContain("var gql = {");
	});

	it("declares gql.query function", () => {
		expect(source).toContain("query: async function(query, variables)");
	});

	it("routes through codemode.__graphql_proxy", () => {
		expect(source).toContain("codemode.__graphql_proxy");
	});

	it("declares the db object with stage and queryStaged", () => {
		expect(source).toContain("var db = {");
		expect(source).toContain("queryStaged: function(dataAccessId, sql)");
		expect(source).toContain("stage: function(data, tableNameOrOptions)");
	});

	it("declares the api.query alias", () => {
		expect(source).toContain("var api = {");
		expect(source).toContain("query: function(dataAccessId, sql)");
	});

	it("includes __wrapStaged for staged response handling", () => {
		expect(source).toContain("function __wrapStaged(raw)");
		expect(source).toContain("__stagedResults.push(raw)");
	});

	it("includes __stageData for db.stage", () => {
		expect(source).toContain("async function __stageData(data, tableNameOrOptions)");
		expect(source).toContain("codemode.__stage_proxy");
	});

	it("includes __queryStaged for SQL queries", () => {
		expect(source).toContain("async function __queryStaged(dataAccessId, sql)");
		expect(source).toContain("codemode.__query_proxy");
	});

	it("handles GraphQL errors with __gql_error flag", () => {
		expect(source).toContain("result.__gql_error");
	});

	it("handles staged responses with __staged flag", () => {
		expect(source).toContain("result.__staged");
	});
});
