import { describe, it, expect } from "vitest";
import { SchemaValidator, type SchemaValidationResult } from "./schema-validator";
import type { InferredSchema } from "./schema-to-ddl";

const testSchema: InferredSchema = {
	tables: [
		{
			name: "variants",
			columns: [
				{ name: "gene", type: "TEXT" },
				{ name: "clinical_status", type: "TEXT" },
				{ name: "position", type: "INTEGER" },
				{ name: "score", type: "REAL" },
			],
			indexes: [],
		},
		{
			name: "studies",
			columns: [
				{ name: "id", type: "TEXT" },
				{ name: "title", type: "TEXT" },
				{ name: "status", type: "TEXT" },
				{ name: "enrollment", type: "INTEGER" },
			],
			indexes: [],
		},
	],
};

describe("SchemaValidator", () => {
	const validator = new SchemaValidator(testSchema);

	describe("valid queries", () => {
		it("passes valid SELECT with known columns", () => {
			const result = validator.validate(
				"SELECT gene, clinical_status FROM variants LIMIT 10",
			);
			expect(result.valid).toBe(true);
			expect(result.diagnostics).toHaveLength(0);
		});

		it("passes SELECT * queries", () => {
			const result = validator.validate("SELECT * FROM variants");
			expect(result.valid).toBe(true);
		});

		it("passes queries with known table names", () => {
			const result = validator.validate(
				"SELECT title FROM studies WHERE status = 'active'",
			);
			expect(result.valid).toBe(true);
		});

		it("passes queries referencing id column", () => {
			const result = validator.validate(
				"SELECT id, gene FROM variants LIMIT 5",
			);
			expect(result.valid).toBe(true);
		});
	});

	describe("column typo detection", () => {
		it("catches misspelled column name with suggestion", () => {
			const result = validator.validate(
				"SELECT clincal_status FROM variants",
			);
			expect(result.valid).toBe(false);
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].message).toBe(
				"unknown column 'clincal_status'",
			);
			expect(result.diagnostics[0].help).toBe(
				"did you mean 'clinical_status'?",
			);
			expect(result.diagnostics[0].kind).toBe("unknown_column");
		});

		it("catches another column typo", () => {
			const result = validator.validate(
				"SELECT gen FROM variants",
			);
			expect(result.valid).toBe(false);
			expect(result.diagnostics[0].help).toContain("gene");
		});

		it("catches column typo in WHERE clause", () => {
			const result = validator.validate(
				"SELECT * FROM variants WHERE clincal_status = 'active'",
			);
			expect(result.valid).toBe(false);
			expect(result.diagnostics[0].help).toContain("clinical_status");
		});
	});

	describe("table typo detection", () => {
		it("catches misspelled table name with suggestion", () => {
			const result = validator.validate(
				"SELECT * FROM varients",
			);
			expect(result.valid).toBe(false);
			expect(result.diagnostics[0].message).toBe(
				"unknown table 'varients'",
			);
			expect(result.diagnostics[0].help).toBe(
				"did you mean 'variants'?",
			);
			expect(result.diagnostics[0].kind).toBe("unknown_table");
		});
	});

	describe("no false positives", () => {
		it("does not flag aliases", () => {
			const result = validator.validate(
				"SELECT COUNT(*) as total FROM variants",
			);
			// 'total' is an alias — should not be flagged since no close match
			expect(result.valid).toBe(true);
		});

		it("does not flag SQL functions", () => {
			const result = validator.validate(
				"SELECT COUNT(gene), MAX(score) FROM variants",
			);
			expect(result.valid).toBe(true);
		});

		it("does not flag string literals", () => {
			const result = validator.validate(
				"SELECT * FROM variants WHERE gene = 'BRCA1'",
			);
			expect(result.valid).toBe(true);
		});
	});

	describe("formatErrorMessage", () => {
		it("formats single error with help", () => {
			const result: SchemaValidationResult = {
				valid: false,
				diagnostics: [
					{
						severity: "error",
						message: "unknown column 'nme'",
						help: "did you mean 'name'?",
						kind: "unknown_column",
					},
				],
			};
			expect(SchemaValidator.formatErrorMessage(result)).toBe(
				"unknown column 'nme' (did you mean 'name'?)",
			);
		});

		it("joins multiple diagnostics", () => {
			const result: SchemaValidationResult = {
				valid: false,
				diagnostics: [
					{
						severity: "error",
						message: "unknown table 'usr'",
						kind: "unknown_table",
					},
					{
						severity: "error",
						message: "unknown column 'nme'",
						help: "did you mean 'name'?",
						kind: "unknown_column",
					},
				],
			};
			expect(SchemaValidator.formatErrorMessage(result)).toBe(
				"unknown table 'usr'; unknown column 'nme' (did you mean 'name'?)",
			);
		});

		it("returns empty for valid result", () => {
			expect(
				SchemaValidator.formatErrorMessage({ valid: true, diagnostics: [] }),
			).toBe("");
		});
	});
});
