import { BUILD_GIT_SHA } from "@bio-mcp/provenance-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { defineTool, toolErr, toolOk } from "./define-tool";
import { feedbackReport, feedbackSource, hasSensitiveFeedback, type FeedbackReport } from "./feedback-schema";

interface FeedbackEnv {
  MCP_FEEDBACK_SOURCE?: string;
  FEEDBACK_INBOX?: { submit(source: string, build: string, report: FeedbackReport): Promise<unknown> };
}

export function registerFeedback(server: McpServer, env: unknown): void {
  const { MCP_FEEDBACK_SOURCE: source, FEEDBACK_INBOX: inbox } = (env ?? {}) as FeedbackEnv;
  if (!source || !feedbackSource.safeParse(source).success) return;
  defineTool(server, {
    name: source.replaceAll("-", "_") + "_feedback",
    title: "Send server feedback",
    description: "Send a short report about this server to its maintainers when a tool fails, produces incorrect results, or a capability is missing. Omit patient information, credentials, private identifiers, raw inputs, outputs and transcripts. Submit once and continue the original task.",
    inputSchema: feedbackReport.shape,
    source: { id: source, name: "MCP feedback inbox" },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler(report) {
      if (hasSensitiveFeedback(report.summary) || hasSensitiveFeedback(report.tool ?? "")) {
        return toolErr("SENSITIVE_FEEDBACK", "Remove identifying information and credentials before submitting.");
      }
      try {
        const receipt = await inbox?.submit(source, BUILD_GIT_SHA, report);
        if (receipt === "rate_limited") return toolErr("RATE_LIMITED", "Feedback volume limit reached. Continue your task.");
        if (receipt === "conflict") return toolErr("ID_CONFLICT", "This submission ID already identifies another report.");
        const id = z.uuid().safeParse(receipt);
        if (id.success) return toolOk({ feedback_id: id.data });
      } catch {
        // RPC and storage exceptions may include request data.
      }
      return toolErr("FEEDBACK_UNAVAILABLE", "Feedback storage could not be confirmed. Reuse the submission ID if retrying.");
    },
  });
}
