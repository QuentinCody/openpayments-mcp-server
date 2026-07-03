import { describe, expect, it } from "vitest";
import {
	enrichStagedQueryError,
	reframeCompoundSelect,
	renderStagedSchemaHint,
} from "./query-error-hint";

describe("renderStagedSchemaHint", () => {
	it("renders the per-server get_schema shape (object-keyed tables)", () => {
		const schema = {
			data_access_id: "abc",
			schema: {
				table_count: 2,
				tables: {
					associations: { columns: [{ name: "pvalue" }, { name: "beta" }, { name: "rsid" }] },
					traits: { columns: [{ name: "id" }, { name: "label" }] },
				},
			},
		};
		const h = renderStagedSchemaHint(schema);
		expect(h).toContain("associations(pvalue, beta, rsid)");
		expect(h).toContain("traits(id, label)");
		expect(h).toContain("EXACT names");
	});

	it("renders the workspace shape (datasets[].tables array)", () => {
		const schema = {
			workspace_id: "ws1",
			schema: {
				datasets: [
					{ tables: [{ name: "gwas__assoc", columns: [{ name: "p" }, { name: "or" }] }] },
				],
			},
		};
		expect(renderStagedSchemaHint(schema)).toContain("gwas__assoc(p, or)");
	});

	it("handles a bare schema (no outer wrapper) and string-column lists", () => {
		expect(
			renderStagedSchemaHint({ tables: { t: { columns: ["a", "b"] } } }),
		).toContain("t(a, b)");
	});

	it("returns empty when there are no tables", () => {
		expect(renderStagedSchemaHint({ schema: { tables: {} } })).toBe("");
		expect(renderStagedSchemaHint(null)).toBe("");
		expect(renderStagedSchemaHint({ success: false })).toBe("");
	});
});

describe("reframeCompoundSelect", () => {
	it("rewrites the Cloudflare compound-SELECT cap into a remedy", () => {
		const out = reframeCompoundSelect("too many terms in compound SELECT: SQLITE_ERROR");
		expect(out).toMatch(/UNION/);
		expect(out).toMatch(/batches of at most 8|individually/);
	});
	it("passes other errors through unchanged", () => {
		expect(reframeCompoundSelect("no such column: x")).toBe("no such column: x");
	});
});

describe("enrichStagedQueryError", () => {
	const schema = { schema: { tables: { t: { columns: [{ name: "a" }, { name: "b" }] } } } };
	it("appends the real schema to a 'no such column' error", async () => {
		const out = await enrichStagedQueryError("no such column: p", async () => schema);
		expect(out).toContain("no such column: p");
		expect(out).toContain("t(a, b)");
	});
	it("appends schema for 'no such table' too", async () => {
		expect(await enrichStagedQueryError("no such table: foo", async () => schema)).toContain(
			"t(a, b)",
		);
	});
	it("reframes compound-SELECT WITHOUT fetching schema", async () => {
		let fetched = false;
		const out = await enrichStagedQueryError("too many terms in compound SELECT", async () => {
			fetched = true;
			return schema;
		});
		expect(out).toMatch(/UNION/);
		expect(fetched).toBe(false);
	});
	it("falls back to the plain error if the schema fetch throws", async () => {
		const out = await enrichStagedQueryError("no such column: p", async () => {
			throw new Error("DO down");
		});
		expect(out).toBe("no such column: p");
	});
});
