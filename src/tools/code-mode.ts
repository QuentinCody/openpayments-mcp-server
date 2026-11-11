import { openpayResponse } from "../lib/tool-result";
/**
 * OpenPayments Code Mode — registers search + execute tools for full API access.
 *
 * search: In-process catalog query, returns matching endpoints with docs.
 * execute: V8 isolate with api.get + searchSpec/listCategories.
 */

import type { McpServer } from "@bio-mcp/shared/mcp";
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
    const registrar = { tool: (...args: unknown[]) => {
        // SAFETY: shared factories supply SDK arguments; only the alias name changes.
        const register = server.tool.bind(server) as (...values: unknown[]) => void;
        const [name, ...rest] = args;
        const handler = rest.pop() as (input: unknown, extra: unknown) => ReturnType<typeof openpayResponse>;
        const respond = (input: unknown, extra: unknown) => openpayResponse(() => handler(input, extra), env, String(name), extra, input);
        register(name, ...rest, respond); register(`mcp_${String(name)}`, ...rest, respond);
    } };

    // Register the search tool (in-process, no isolate)
    const searchTool = createSearchTool({
        prefix: "openpay",
        catalog: openPaymentsCatalog,
    });
    searchTool.register(registrar);

    // Register the execute tool (V8 isolate via DynamicWorkerExecutor)
    const executeTool = createExecuteTool({
        prefix: "openpay",
        // Verifiable provenance: openpay_execute results carry a _meta.citation.
        source: { id: "openpay", name: "CMS Open Payments", url: "https://openpaymentsdata.cms.gov", license: "U.S. Public Domain" },
        catalog: openPaymentsCatalog,
        apiFetch,
        preserveApiErrors: true,
        maxInlineBytes: 30 * 1024,
        stagingThreshold: 30 * 1024,
        timeout: 60_000,
        doNamespace: env.OPENPAYMENTS_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(registrar);
}
