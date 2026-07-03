import { describe, expect, it } from "vitest";
import { buildGraphqlExecuteDescription } from "./graphql-execute-description";

describe("buildGraphqlExecuteDescription", () => {
	it("describes the gql.query / schema / staging surface and includes the API name", () => {
		const d = buildGraphqlExecuteDescription({ prefix: "dgidb", apiName: "DGIdb" }, "");
		expect(d).toContain("DGIdb GraphQL API");
		expect(d).toContain("gql.query(queryString, variables?)");
		expect(d).toContain("schema.queryRoot()");
		expect(d).toContain("STAGING:");
		expect(d).toContain("dgidb_query_data");
	});

	it("embeds the provided schema summary (T2.2 — real schema in the description)", () => {
		const d = buildGraphqlExecuteDescription({ prefix: "dgidb" }, "TYPE Gene { interactions: [Interaction] }");
		expect(d).toContain("TYPE Gene { interactions: [Interaction] }");
	});

	it("appends SERVER NOTES extracted from a preamble's // comment lines", () => {
		const d = buildGraphqlExecuteDescription(
			{ prefix: "dgidb", preamble: "// use genes(names:[...])\nconst x = 1; // inline" },
			"",
		);
		expect(d).toContain("SERVER NOTES:");
		expect(d).toContain("use genes(names:[...])");
	});

	it("includes fs.* lines only when a filesystem DO is wired", () => {
		expect(buildGraphqlExecuteDescription({ prefix: "p", fsDoNamespace: {} }, "")).toContain("fs.readFile(path)");
		expect(buildGraphqlExecuteDescription({ prefix: "p" }, "")).not.toContain("fs.readFile(path)");
	});
});
