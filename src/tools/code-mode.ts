/**
 * OpenPayments Code Mode — registers search + execute tools for full API access.
 *
 * search: In-process catalog query, returns matching endpoints with docs.
 * execute: V8 isolate with api.get + searchSpec/listCategories.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { openPaymentsCatalog } from "../spec/catalog";
import { createOpenPaymentsApiFetch } from "../lib/api-adapter";

interface CodeModeEnv {
    OPENPAYMENTS_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

/**
 * Register openpay_search and openpay_execute tools.
 */
export function registerCodeMode(server: McpServer, env: CodeModeEnv): void {
    const apiFetch = createOpenPaymentsApiFetch();

    // Register the search tool (in-process, no isolate)
    const searchTool = createSearchTool({
        prefix: "openpay",
        catalog: openPaymentsCatalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    // Register the execute tool (V8 isolate via DynamicWorkerExecutor)
    const executeTool = createExecuteTool({
        prefix: "openpay",
        catalog: openPaymentsCatalog,
        apiFetch,
        doNamespace: env.OPENPAYMENTS_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
