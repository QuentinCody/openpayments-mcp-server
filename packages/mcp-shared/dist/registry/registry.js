import { z } from "zod";
/**
 * Unified tool registry — the single place tools are defined.
 *
 * Derives MCP registration, isolate call routing, executor function maps,
 * and type generation from the same ToolEntry definitions.
 */
export class ToolRegistry {
    tools = [];
    toolByName = new Map();
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /**
     * Add tool entries to the registry.
     */
    add(...entries) {
        this.tools.push(...entries);
        for (const entry of entries) {
            this.toolByName.set(entry.name, entry);
        }
    }
    /**
     * Register all tools with the MCP server.
     * Wraps each handler to produce MCP-formatted responses.
     * Hidden tools are skipped — they're only callable from V8 isolates.
     */
    registerAll(server) {
        for (const tool of this.tools) {
            if (tool.hidden)
                continue;
            const ctx = this.ctx;
            server.tool(tool.name, tool.description, tool.schema, async (input) => {
                try {
                    const result = await tool.handler(input, ctx);
                    return {
                        content: [{ type: "text", text: result === undefined ? "undefined" : JSON.stringify(result) }],
                    };
                }
                catch (e) {
                    const error = e instanceof Error ? e.message : String(e);
                    return {
                        isError: true,
                        content: [{ type: "text", text: JSON.stringify({ error }) }],
                    };
                }
            });
        }
    }
    /**
     * Handle a tool call from a V8 isolate (via CodeModeProxy → DO RPC).
     */
    async handleIsolateCall(functionName, args) {
        const tool = this.toolByName.get(functionName);
        if (!tool) {
            return { error: `Unknown tool: ${functionName}` };
        }
        const input = (args[0] ?? {});
        return tool.handler(input, this.ctx);
    }
    /**
     * Build a function map of ALL tools (including hidden) for the DynamicWorkerExecutor.
     * Each function takes a single args object and returns the handler result.
     */
    buildExecutorFns(ctx) {
        const fns = {};
        for (const tool of this.tools) {
            const t = tool;
            fns[t.name] = async (args) => {
                const input = (args ?? {});
                return t.handler(input, ctx);
            };
        }
        return fns;
    }
    /**
     * Convert non-hidden tools to ToolDescriptors for generateTypes().
     * Wraps the shape Record<string, ZodType> into z.object() since
     * generateTypes expects inputSchema to be a ZodType.
     */
    toToolDescriptors() {
        const descriptors = {};
        for (const tool of this.tools) {
            if (tool.hidden)
                continue;
            descriptors[tool.name] = {
                description: tool.description,
                inputSchema: z.object(tool.schema),
            };
        }
        return descriptors;
    }
    /**
     * Get tool definitions for type generation.
     * Returns the shape expected by generateTypes().
     * Hidden tools are excluded — they get separate type declarations.
     */
    getDefinitions() {
        return this.tools
            .filter((t) => !t.hidden)
            .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.schema,
        }));
    }
}
//# sourceMappingURL=registry.js.map