import { expect, it } from "vitest";
import { createApiProxyTool } from "./api-proxy";
import { createExecuteTool } from "../codemode/execute-tool";

it("enforces the transport ceiling in UTF-8 bytes without a staging binding", async () => {
  const tool = createApiProxyTool({ apiFetch: async () => ({ status: 200, data: { text: "α".repeat(60_000) } }) });
  expect(await tool.handler({ method: "GET", path: "/entry" }, { sql: () => [] })).toMatchObject({ __api_error: true, status: 413, code: "RESPONSE_TOO_LARGE" });
});

it("propagates a hard inline ceiling through the execute factory for a single record", async () => {
  const tool = createExecuteTool({ prefix: "fixture", loader: { get: () => ({}) }, maxInlineBytes: 30 * 1024,
    catalog: { name: "Fixture", baseUrl: "https://example.test", endpoints: [] },
    apiFetch: async () => ({ status: 200, data: { text: "α".repeat(17_000) } }),
  });
  expect(await tool.apiProxyTool.handler({ method: "GET", path: "/entry" }, { sql: () => [] })).toMatchObject({ __api_error: true, status: 413, code: "RESPONSE_TOO_LARGE" });
});

it("keeps the existing single-record policy when no hard ceiling is configured", async () => {
  const data = { text: "α".repeat(17_000) };
  const tool = createApiProxyTool({ apiFetch: async () => ({ status: 200, data }) });
  expect(await tool.handler({ method: "GET", path: "/entry" }, { sql: () => [] })).toEqual(data);
});
