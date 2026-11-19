import { expect, it } from "vitest";
import { feedbackReport, feedbackSource, hasSensitiveFeedback } from "./feedback-schema";

it("accepts bounded reports and rejects unexpected fields and common sensitive text", () => {
  const report = { category: "bug", impact: "blocked", summary: "Expected two pages." };
  expect(feedbackSource.safeParse("clinicaltrials").success).toBe(true);
  expect(feedbackReport.safeParse(report).success).toBe(true);
  expect(feedbackReport.safeParse({ ...report, headers: {} }).success).toBe(false);
  expect(feedbackReport.safeParse({ ...report, summary: " ".repeat(42) }).success).toBe(false);
  expect(feedbackReport.safeParse({ ...report, summary: "a".repeat(1201) }).success).toBe(false);
  expect(hasSensitiveFeedback("Observed an error for test@example.test")).toBe(true);
  expect(hasSensitiveFeedback(report.summary)).toBe(false);
});
