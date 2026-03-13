/**
 * Type generation for Code Mode.
 *
 * Lightweight Zod schema → TypeScript string conversion that runs in Workers
 * (no dependency on the TypeScript compiler or zod-to-ts).
 *
 * Walks Zod v4 schema internals (_zod.def.type) to produce type strings.
 */
function toCamelCase(str) {
    return str
        .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
        .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}
function isZodSchema(val) {
    return val !== null && typeof val === "object" && "_zod" in val;
}
/**
 * Convert a Zod schema to a TypeScript type string.
 */
function zodToTypeString(schema) {
    if (!isZodSchema(schema))
        return "any";
    const def = schema._zod.def;
    switch (def.type) {
        case "string":
            return "string";
        case "number":
        case "int":
            return "number";
        case "boolean":
            return "boolean";
        case "bigint":
            return "bigint";
        case "null":
            return "null";
        case "undefined":
            return "undefined";
        case "void":
            return "void";
        case "any":
            return "any";
        case "unknown":
            return "unknown";
        case "never":
            return "never";
        case "date":
            return "Date";
        case "nan":
            return "number";
        case "literal": {
            const value = def.value;
            if (typeof value === "string")
                return `"${value}"`;
            if (typeof value === "number" || typeof value === "boolean")
                return String(value);
            return "any";
        }
        case "enum": {
            const values = def.entries;
            if (values && typeof values === "object") {
                return Object.values(values).map((v) => (typeof v === "string" ? `"${v}"` : String(v))).join(" | ");
            }
            return "string";
        }
        case "array": {
            const innerType = def.element;
            const inner = zodToTypeString(innerType);
            return inner.includes("|") ? `(${inner})[]` : `${inner}[]`;
        }
        case "object": {
            const shape = def.shape;
            if (!shape || typeof shape !== "object")
                return "Record<string, any>";
            const entries = Object.entries(shape);
            if (entries.length === 0)
                return "{}";
            const fields = entries.map(([key, val]) => {
                const optional = isZodSchema(val) && (val._zod.def.type === "optional" || val._zod?.optin === "optional");
                const typeStr = zodToTypeString(val);
                const desc = isZodSchema(val) && val._zod.description ? ` // ${val._zod.description}` : "";
                return `\t${key}${optional ? "?" : ""}: ${typeStr};${desc}`;
            }).join("\n");
            return `{\n${fields}\n}`;
        }
        case "optional": {
            const inner = def.innerType;
            return `${zodToTypeString(inner)} | undefined`;
        }
        case "nullable": {
            const inner = def.innerType;
            return `${zodToTypeString(inner)} | null`;
        }
        case "union": {
            const options = def.options;
            if (options && Array.isArray(options)) {
                return options.map(zodToTypeString).join(" | ");
            }
            return "any";
        }
        case "record": {
            const valueType = def.valueType;
            return `Record<string, ${zodToTypeString(valueType)}>`;
        }
        case "tuple": {
            const items = def.items;
            if (items && Array.isArray(items)) {
                return `[${items.map(zodToTypeString).join(", ")}]`;
            }
            return "any[]";
        }
        case "promise": {
            const inner = def.innerType;
            return `Promise<${zodToTypeString(inner)}>`;
        }
        case "pipe":
        case "transform":
        case "default":
        case "catch":
        case "readonly": {
            const inner = def.innerType;
            return zodToTypeString(inner);
        }
        default:
            return "any";
    }
}
/**
 * Generate TypeScript type definitions from a set of tool definitions.
 * Returns a string containing type declarations and a `declare const codemode` block.
 */
export function generateTypes(tools) {
    let availableTools = "";
    let availableTypes = "";
    for (const tool of tools) {
        const typeName = toCamelCase(tool.name);
        const inputTypeName = `${typeName}Input`;
        let inputType;
        const schema = tool.inputSchema;
        if (isZodSchema(schema)) {
            // Full Zod schema (e.g., z.object({...}))
            const tsType = zodToTypeString(schema);
            inputType = `type ${inputTypeName} = ${tsType}`;
        }
        else if (schema && typeof schema === "object") {
            // Shape object (e.g., { query: z.string(), ... })
            const keys = Object.keys(schema);
            if (keys.length === 0) {
                inputType = `type ${inputTypeName} = {}`;
            }
            else {
                const fields = keys
                    .map((key) => {
                    const val = schema[key];
                    const optional = isZodSchema(val) && (val._zod.def.type === "optional" || val._zod?.optin === "optional");
                    const typeStr = zodToTypeString(val);
                    let desc = "";
                    if (isZodSchema(val) && val._zod.description) {
                        desc = ` // ${val._zod.description}`;
                    }
                    return `\t${key}${optional ? "?" : ""}: ${typeStr};${desc}`;
                })
                    .join("\n");
                inputType = `interface ${inputTypeName} {\n${fields}\n}`;
            }
        }
        else {
            inputType = `type ${inputTypeName} = {}`;
        }
        const outputTypeName = `${typeName}Output`;
        const outputType = `type ${outputTypeName} = any`;
        availableTypes += `\n${inputType}`;
        availableTypes += `\n${outputType}`;
        if (tool.description) {
            availableTools += `\n\t/** ${tool.description.trim()} */`;
        }
        availableTools += `\n\t${tool.name}: (input: ${inputTypeName}) => Promise<${outputTypeName}>;`;
        availableTools += "\n";
    }
    availableTools = `\ndeclare const codemode: {${availableTools}}`;
    // Direct query helpers — injected into the V8 isolate alongside codemode
    const queryHelpers = [
        "",
        "/** Execute a read-only SQL query. Returns rows directly. Faster than codemode.sql_query() for SELECT queries. */",
        "declare function query(sql: string, params?: (string | number | boolean | null)[]): Promise<Record<string, unknown>[]>;",
        "",
        "/** Execute multiple read-only SQL queries in a single round-trip. Returns an array of row arrays. */",
        "declare function queryBatch(queries: { sql: string; params?: (string | number | boolean | null)[] }[]): Promise<Array<Record<string, unknown>[]>>;",
        "",
        "/** Store an array of flat objects into a SQLite table. Creates table if needed, evolves schema for new columns. Returns a summary instead of full data. */",
        "declare function store(",
        "  tableName: string,",
        "  data: Record<string, string | number | boolean | null>[]",
        "): Promise<{ table: string; rows_inserted: number; columns: string[]; created?: boolean; columns_added?: string[] }>;",
    ].join("\n");
    return `${availableTypes}\n${availableTools}\n${queryHelpers}\n`;
}
//# sourceMappingURL=types.js.map