import { expect, it } from "vitest";
import { materializationWarnings } from "./materialization-result";

it.each([0, 1, 10])("retains skipped-row diagnostics and the existing loss threshold (%s failures)", failedRows => {
  const warnings = failedRows ? [{ rowIndex: 3, table: "fixture", error: "bad value" }] : [];
  const result = materializationWarnings({ totalRows: 100 - failedRows, inputRows: 100, failedRows, warnings, tablesCreated: ["fixture"], tableRowCounts: { fixture: 100 - failedRows } });
  expect(result).toEqual(failedRows ? { rows_skipped: failedRows, sample_errors: [{ row: 3, table: "fixture", error: "bad value" }], ...(failedRows > 5 ? { data_loss_warning: "10 of 100 rows (10.0%) failed to stage. This exceeds the 5% threshold. Review sample_errors for details." } : {}) } : {});
});
