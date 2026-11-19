import { z } from "zod";

export const feedbackSource = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const feedbackReport = z.strictObject({
  category: z.enum(["bug", "incorrect_result", "missing_capability", "documentation", "other"]),
  impact: z.enum(["blocked", "workaround", "suggestion"]),
  tool: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional().describe("Affected MCP tool name, if known."),
  summary: z.string().trim().min(8).max(1200).describe("Describe what you expected and what happened using a non-sensitive example."),
  submission_id: z.uuid().optional().describe("Generate once per report and reuse on retries."),
});

export type FeedbackReport = z.infer<typeof feedbackReport>;

export function hasSensitiveFeedback(text: string): boolean {
  return /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\bbearer\s+\S+|-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|\b(?:sk-|ghp_|github_pat_)[a-z0-9_-]{12,}/i.test(text);
}
