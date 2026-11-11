import { expect, it } from "vitest";
import { buildGraphqlProxySource } from "../codemode/graphql-proxy";
import { createGraphqlProxyTool } from "./graphql-proxy";

it.each(["success", "partial", "errors"])("stages multibyte %s evidence by UTF-8 bytes", async (kind) => {
  const stored: unknown[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/process") {
        stored.push((await request.json() as {data: unknown}).data);
        return Response.json({success: true, tables_created: ["evidence"], total_rows: 1, input_rows: 1});
      }
      return Response.json({success: true, schema: {tables: {}}});
    }}),
  };
  // The errors-only envelope duplicates messages; keep even that JSON below
  // the single-record character threshold while exceeding its byte threshold.
  const text = "α".repeat(kind === "errors" ? 30000 : 60000);
  const data = {target: {description: text}};
  const errors = [{message: kind === "errors" ? text : "source unavailable"}];
  const expected = kind === "success" ? data : kind === "partial" ? {...data, __errors: errors} : {__gql_error: true, message: text, errors};
  expect(JSON.stringify(expected).length).toBeLessThan(90 * 1024);
  expect(new TextEncoder().encode(JSON.stringify(expected)).byteLength).toBeGreaterThan(100000);
  const tool = createGraphqlProxyTool({
    stagingPrefix: "utf8", doNamespace: namespace,
    gqlFetch: async () => kind === "errors" ? {errors} : {data, ...(kind === "partial" ? {errors} : {})},
  });
  const result = await tool.handler({query: "{ target { description } }"}, {sql: () => []});
  expect(result).toMatchObject(kind === "errors"
    ? {__gql_error: true, code: "ERROR_EVIDENCE_STAGED", evidence: {__staged: true, _staging: expect.any(Object)}}
    : {__staged: true, _staging: expect.any(Object)});
  expect(stored).toContainEqual(expected);
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30 * 1024);
  if (kind === "errors") {
    const query = new Function("codemode", `var __stagedResults=[]; ${buildGraphqlProxySource()} return gql.query;`)({__graphql_proxy: async () => result});
    const handle = (result as {evidence: {data_access_id: string}}).evidence.data_access_id;
    // The isolate throws errors-only results; its message must retain the
    // retrieval ID even when Error custom properties are not serialized.
    await expect(query("{ target { description } }")).rejects.toThrow(`data_access_id=${handle}`);
  }
});
