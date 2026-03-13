import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createQueryDataHandler } from "@bio-mcp/shared/staging/utils";

interface QueryEnv {
    OPENPAYMENTS_DATA_DO?: unknown;
}

export function registerQueryData(server: McpServer, env?: QueryEnv) {
    const handler = createQueryDataHandler("OPENPAYMENTS_DATA_DO", "openpay");

    server.registerTool(
        "openpay_query_data",
        {
            title: "Query Staged Open Payments Data",
            description:
                "Query staged Open Payments data using SQL. Use this when responses are too large and have been staged with a data_access_id.",
            inputSchema: {
                data_access_id: z
                    .string()
                    .min(1)
                    .describe("Data access ID for the staged dataset"),
                sql: z
                    .string()
                    .min(1)
                    .describe("SQL query to execute against the staged data"),
                limit: z
                    .number()
                    .int()
                    .positive()
                    .max(10000)
                    .default(100)
                    .optional()
                    .describe("Maximum number of rows to return (default: 100)"),
            },
        },
        async (args, extra) => {
            const runtimeEnv = env || (extra as { env?: QueryEnv })?.env || {};
            return handler(
                args as Record<string, unknown>,
                runtimeEnv as Record<string, unknown>,
            );
        },
    );
}
