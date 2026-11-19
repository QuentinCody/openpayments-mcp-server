import { describe, expect, it, vi } from "vitest";
import { McpServer, createMcpHandler } from "../mcp/stateless-worker";
import { registerFeedback } from "./feedback";

const report = { category: "bug", impact: "workaround", summary: "Second page repeated the first row." };

async function call(name: string, args: unknown, submit?: (...args: unknown[]) => Promise<unknown>) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "test", version: "1" });
    registerFeedback(server, { MCP_FEEDBACK_SOURCE: "test-server", FEEDBACK_INBOX: submit && { submit } });
    return server;
  }, { legacy: "stateless" });
  const response = await handler.fetch(new Request("https://test.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-method": "tools/call", "mcp-name": name, "mcp-protocol-version": "2026-07-28" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  }));
  return (await response.json() as { result: { isError?: boolean; content: unknown[]; structuredContent: Record<string, unknown> } }).result;
}

describe("feedback tool", () => {
  it.each(["test_server_feedback", "mcp_test_server_feedback"])("returns a persisted receipt from %s", async name => {
    const id = crypto.randomUUID();
    const submit = vi.fn().mockResolvedValue(id);
    const result = await call(name, report, submit);
    expect(submit).toHaveBeenCalledWith("test-server", expect.any(String), report);
    expect(result.structuredContent).toMatchObject({ success: true, data: { feedback_id: id }, _meta: { citation: { result_hash: expect.any(String) } } });
    expect(result.content.length).toBeGreaterThan(0);
  });

  it.each([
    [report, undefined, "FEEDBACK_UNAVAILABLE"],
    [report, async (): Promise<never> => { throw new Error("internal detail"); }, "FEEDBACK_UNAVAILABLE"],
    [report, async (): Promise<string> => "rate_limited", "RATE_LIMITED"],
    [report, async (): Promise<string> => "conflict", "ID_CONFLICT"],
    [{ ...report, summary: "Contains a bearer example" }, undefined, "SENSITIVE_FEEDBACK"],
    [{ ...report, summary: "" }, undefined, "INPUT_VALIDATION_ERROR"],
  ] as const)("surfaces a structured failure", async (input, sink, code) => {
    const result = await call("test_server_feedback", input, sink);
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code } } });
    expect(result.content.length).toBeGreaterThan(0);
  });
});
