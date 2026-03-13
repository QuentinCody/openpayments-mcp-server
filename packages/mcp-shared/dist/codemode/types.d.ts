/**
 * Type generation for Code Mode.
 *
 * Lightweight Zod schema → TypeScript string conversion that runs in Workers
 * (no dependency on the TypeScript compiler or zod-to-ts).
 *
 * Walks Zod v4 schema internals (_zod.def.type) to produce type strings.
 */
export type ToolDefinition = {
    name: string;
    description?: string;
    inputSchema: unknown;
};
/**
 * Generate TypeScript type definitions from a set of tool definitions.
 * Returns a string containing type declarations and a `declare const codemode` block.
 */
export declare function generateTypes(tools: ToolDefinition[]): string;
//# sourceMappingURL=types.d.ts.map