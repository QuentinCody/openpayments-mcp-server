/**
 * Type generation for Code Mode.
 *
 * Lightweight Zod schema → TypeScript string conversion that runs in Workers
 * (no dependency on the TypeScript compiler or zod-to-ts).
 *
 * Walks Zod v4 schema internals (_zod.def.type) to produce type strings.
 */

function toCamelCase(str: string): string {
	return str
		.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
		.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

export type ToolDefinition = {
	name: string;
	description?: string;
	inputSchema: unknown; // Zod schema or shape object
};

interface ZodInternals {
	def: { type: string; [key: string]: unknown };
	description?: string;
	[key: string]: unknown;
}

interface ZodLike {
	_zod: ZodInternals;
	[key: string]: unknown;
}

type ZodDef = Record<string, unknown>;

function isZodSchema(val: unknown): val is ZodLike {
	return (
		val !== null &&
		typeof val === "object" &&
		"_zod" in (val as Record<string, unknown>)
	);
}

/** Inner schema of a single-wrapper Zod type (optional/nullable/promise/…). */
function innerTypeOf(def: ZodDef): unknown {
	return (def as { innerType?: unknown }).innerType;
}

/**
 * Description text attached to a schema. Zod v4 exposes this through the public
 * `.description` getter (registry-backed), NOT `_zod.description` (which v3 used).
 */
function zodDescription(val: unknown): string | undefined {
	if (!isZodSchema(val)) return undefined;
	const description = (val as { description?: unknown }).description;
	return typeof description === "string" && description.length > 0
		? description
		: undefined;
}

/** Whether an object field schema is optional (so its key gets a trailing `?`). */
function isOptionalField(val: unknown): boolean {
	return (
		isZodSchema(val) &&
		(val._zod.def.type === "optional" ||
			(val._zod as { optin?: string }).optin === "optional")
	);
}

/** Scalar Zod kinds whose TS rendering is a fixed keyword. */
const PRIMITIVE_TS: Record<string, string> = {
	string: "string",
	number: "number",
	int: "number",
	boolean: "boolean",
	bigint: "bigint",
	null: "null",
	undefined: "undefined",
	void: "void",
	any: "any",
	unknown: "unknown",
	never: "never",
	date: "Date",
	nan: "number",
};

/** Single-wrapper kinds that render as their inner type, unchanged. */
const UNWRAP_KINDS = new Set([
	"pipe",
	"transform",
	"default",
	"catch",
	"readonly",
]);

function renderLiteralValue(value: unknown): string {
	if (typeof value === "string") return `"${value}"`;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (value === null) return "null";
	return "any";
}

// Zod v4 stores literal members in `def.values` (an array); v3 used `value`.
function literalToTypeString(def: ZodDef): string {
	const values = (def as { values?: unknown[] }).values;
	if (Array.isArray(values) && values.length > 0) {
		return values.map(renderLiteralValue).join(" | ");
	}
	if ("value" in def)
		return renderLiteralValue((def as { value?: unknown }).value);
	return "any";
}

function enumToTypeString(def: ZodDef): string {
	const entries = (def as { entries?: Record<string, unknown> }).entries;
	if (entries && typeof entries === "object") {
		return Object.values(entries)
			.map((v) => (typeof v === "string" ? `"${v}"` : String(v)))
			.join(" | ");
	}
	return "string";
}

function arrayToTypeString(def: ZodDef): string {
	const inner = zodToTypeString((def as { element?: unknown }).element);
	return inner.includes("|") ? `(${inner})[]` : `${inner}[]`;
}

function unionToTypeString(def: ZodDef): string {
	const options = (def as { options?: unknown[] }).options;
	return Array.isArray(options)
		? options.map(zodToTypeString).join(" | ")
		: "any";
}

function recordToTypeString(def: ZodDef): string {
	return `Record<string, ${zodToTypeString((def as { valueType?: unknown }).valueType)}>`;
}

function tupleToTypeString(def: ZodDef): string {
	const items = (def as { items?: unknown[] }).items;
	return Array.isArray(items)
		? `[${items.map(zodToTypeString).join(", ")}]`
		: "any[]";
}

function optionalToTypeString(def: ZodDef): string {
	return `${zodToTypeString(innerTypeOf(def))} | undefined`;
}

function nullableToTypeString(def: ZodDef): string {
	return `${zodToTypeString(innerTypeOf(def))} | null`;
}

function promiseToTypeString(def: ZodDef): string {
	return `Promise<${zodToTypeString(innerTypeOf(def))}>`;
}

/** Render `\tkey: type;` field lines from an object shape (shared by object + interface output). */
function renderShapeFields(shape: Record<string, unknown>): string {
	return Object.entries(shape)
		.map(([key, val]) => {
			const optional = isOptionalField(val) ? "?" : "";
			const description = zodDescription(val);
			const desc = description ? ` // ${description}` : "";
			return `\t${key}${optional}: ${zodToTypeString(val)};${desc}`;
		})
		.join("\n");
}

function objectToTypeString(def: ZodDef): string {
	const shape = (def as { shape?: Record<string, unknown> }).shape;
	if (!shape || typeof shape !== "object") return "Record<string, unknown>";
	if (Object.keys(shape).length === 0) return "{}";
	return `{\n${renderShapeFields(shape)}\n}`;
}

/** Per-kind renderers for the structural Zod types (the recursive cases). */
const COMPLEX_HANDLERS: Record<string, (def: ZodDef) => string> = {
	literal: literalToTypeString,
	enum: enumToTypeString,
	array: arrayToTypeString,
	object: objectToTypeString,
	optional: optionalToTypeString,
	nullable: nullableToTypeString,
	union: unionToTypeString,
	record: recordToTypeString,
	tuple: tupleToTypeString,
	promise: promiseToTypeString,
};

/**
 * Convert a Zod schema to a TypeScript type string.
 *
 * Exported for unit testing; `generateTypes` is the primary public entry point.
 */
export function zodToTypeString(schema: unknown): string {
	if (!isZodSchema(schema)) return "any";

	const def = schema._zod.def;
	const primitive = PRIMITIVE_TS[def.type];
	if (primitive) return primitive;

	const handler = COMPLEX_HANDLERS[def.type];
	if (handler) return handler(def);

	if (UNWRAP_KINDS.has(def.type)) return zodToTypeString(innerTypeOf(def));
	return "any";
}

/**
 * Generate TypeScript type definitions from a set of tool definitions.
 * Returns a string containing type declarations and a `declare const codemode` block.
 */
export function generateTypes(tools: ToolDefinition[]): string {
	let availableTools = "";
	let availableTypes = "";

	for (const tool of tools) {
		const typeName = toCamelCase(tool.name);
		const inputTypeName = `${typeName}Input`;

		let inputType: string;
		const schema = tool.inputSchema;

		if (isZodSchema(schema)) {
			// Full Zod schema (e.g., z.object({...}))
			inputType = `type ${inputTypeName} = ${zodToTypeString(schema)}`;
		} else if (schema && typeof schema === "object") {
			// Shape object (e.g., { query: z.string(), ... })
			const shape = schema as Record<string, unknown>;
			inputType =
				Object.keys(shape).length === 0
					? `type ${inputTypeName} = {}`
					: `interface ${inputTypeName} {\n${renderShapeFields(shape)}\n}`;
		} else {
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
