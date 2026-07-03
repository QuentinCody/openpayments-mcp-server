/**
 * Conservative pre-flight GraphQL query validation (T1.2).
 *
 * Given a {@link TrimmedIntrospection} schema and a query string, walk the
 * query's selection tree and report the high-frequency mistakes the demo
 * surfaced — unknown field on a type, unknown/rejected argument, and missing
 * required argument — BEFORE the query is sent upstream. This kills the whole
 * "guess the GraphQL shape, get a 500, retry the same broken query" class
 * (dgidb / civic / gnomad / opentargets) locally, with a precise correction.
 *
 * DESIGN BIAS — never false-positive. A false "this field is invalid" would
 * BLOCK a valid query, which is worse than the status quo. So the validator is
 * deliberately conservative:
 *   - It returns `{ checked: false }` (and reports nothing) the moment it meets
 *     anything it can't reason about confidently: a parse it can't complete, a
 *     named fragment spread (adds fields we can't see), a field whose return
 *     type isn't an object/interface/union we can resolve, etc.
 *   - It only reports an error when the offending field/arg is written
 *     explicitly in the query AND the schema unambiguously lacks it.
 * Callers MUST only block when `checked === true && errors.length > 0`.
 */

import type {
	TrimmedField,
	TrimmedIntrospection,
	TrimmedType,
} from "./graphql-introspection";

export interface GqlValidationError {
	/** The type the offending selection was made on. */
	type: string;
	/** The field (or field.arg) at fault. */
	field: string;
	message: string;
}

export interface GqlValidationResult {
	/** True only if the query was fully parsed and walked. False → don't block. */
	checked: boolean;
	errors: GqlValidationError[];
}

// ---------------------------------------------------------------------------
// Minimal selection-set parser (subset of GraphQL grammar)
// ---------------------------------------------------------------------------

interface ParsedField {
	name: string;
	/** Argument NAMES supplied at this field occurrence (values are ignored). */
	args: string[];
	/** Whether an argument list `( ... )` was present at all. */
	hasArgs: boolean;
	selectionSet?: ParsedField[];
}

/** Thrown internally to abort parsing → the validator reports `checked: false`. */
class UnparseableError extends Error {}

class SelectionParser {
	private i = 0;
	constructor(private readonly s: string) {}

	/** Parse a full operation, returning the root selection set. */
	parse(): ParsedField[] {
		this.skipToRootSelection();
		this.expect("{");
		return this.parseSelectionSet();
	}

	/** Advance to the first `{` that opens the root selection set. */
	private skipToRootSelection(): void {
		// Scan for the first top-level `{` not inside a string or parenthesised
		// variable-definition list (e.g. `query Q($x: Int = 1) { ... }`).
		let parenDepth = 0;
		while (this.i < this.s.length) {
			const c = this.s[this.i];
			if (c === '"') {
				this.skipString();
				continue;
			}
			if (c === "(") parenDepth++;
			else if (c === ")") parenDepth--;
			else if (c === "{" && parenDepth === 0) return;
			this.i++;
		}
		throw new UnparseableError("no selection set");
	}

	private parseSelectionSet(): ParsedField[] {
		const fields: ParsedField[] = [];
		for (;;) {
			this.skipTrivia();
			if (this.i >= this.s.length)
				throw new UnparseableError("unterminated selection set");
			const c = this.s[this.i];
			if (c === "}") {
				this.i++;
				return fields;
			}
			if (c === "." && this.s.startsWith("...", this.i)) {
				// Fragment spread / inline fragment — abort: we can't resolve the
				// fields a spread contributes, so we can't validate confidently.
				throw new UnparseableError("fragment");
			}
			fields.push(this.parseField());
		}
	}

	private parseField(): ParsedField {
		let name = this.readName();
		this.skipTrivia();
		// Alias: `alias: field`
		if (this.s[this.i] === ":") {
			this.i++;
			this.skipTrivia();
			name = this.readName();
			this.skipTrivia();
		}
		const field: ParsedField = { name, args: [], hasArgs: false };
		if (this.s[this.i] === "(") {
			field.hasArgs = true;
			field.args = this.parseArgs();
			this.skipTrivia();
		}
		if (this.s[this.i] === "{") {
			this.i++;
			field.selectionSet = this.parseSelectionSet();
		}
		return field;
	}

	/** Parse `( name: value, ... )`, returning the argument names. Values skipped. */
	private parseArgs(): string[] {
		this.expect("(");
		const names: string[] = [];
		for (;;) {
			this.skipTrivia();
			if (this.i >= this.s.length)
				throw new UnparseableError("unterminated args");
			if (this.s[this.i] === ")") {
				this.i++;
				return names;
			}
			const argName = this.readName();
			this.skipTrivia();
			if (this.s[this.i] !== ":")
				throw new UnparseableError("malformed argument");
			this.i++;
			names.push(argName);
			this.skipValue();
			this.skipTrivia();
			if (this.s[this.i] === ",") this.i++;
		}
	}

	/** Skip a single argument value (scalar, string, enum, variable, list, object). */
	private skipValue(): void {
		this.skipTrivia();
		const c = this.s[this.i];
		if (c === undefined) throw new UnparseableError("missing value");
		if (c === '"') {
			this.skipString();
			return;
		}
		if (c === "{" || c === "[") {
			this.skipBalanced(c, c === "{" ? "}" : "]");
			return;
		}
		// Scalar / enum / variable / number / boolean / null — read until a
		// delimiter that ends the value.
		while (this.i < this.s.length) {
			const ch = this.s[this.i];
			if (ch === "," || ch === ")" || ch === "}" || ch === "]" || /\s/.test(ch))
				return;
			this.i++;
		}
	}

	/** Skip a balanced `{...}` or `[...]`, honoring nested strings/brackets. */
	private skipBalanced(open: string, close: string): void {
		let depth = 0;
		while (this.i < this.s.length) {
			const c = this.s[this.i];
			if (c === '"') {
				this.skipString();
				continue;
			}
			if (c === open) depth++;
			else if (c === close) {
				depth--;
				if (depth === 0) {
					this.i++;
					return;
				}
			}
			this.i++;
		}
		throw new UnparseableError("unbalanced");
	}

	/** Skip a string or block string starting at the current `"`. */
	private skipString(): void {
		if (this.s.startsWith('"""', this.i)) {
			this.i += 3;
			const end = this.s.indexOf('"""', this.i);
			if (end < 0) throw new UnparseableError("unterminated block string");
			this.i = end + 3;
			return;
		}
		this.i++; // opening quote
		while (this.i < this.s.length) {
			const c = this.s[this.i];
			if (c === "\\") {
				this.i += 2;
				continue;
			}
			if (c === '"') {
				this.i++;
				return;
			}
			this.i++;
		}
		throw new UnparseableError("unterminated string");
	}

	private readName(): string {
		this.skipTrivia();
		const start = this.i;
		while (this.i < this.s.length && /[A-Za-z0-9_]/.test(this.s[this.i]))
			this.i++;
		if (this.i === start) throw new UnparseableError("expected name");
		return this.s.slice(start, this.i);
	}

	private expect(ch: string): void {
		this.skipTrivia();
		if (this.s[this.i] !== ch) throw new UnparseableError(`expected ${ch}`);
		this.i++;
	}

	/** Skip whitespace, commas, and `#` line comments. */
	private skipTrivia(): void {
		for (;;) {
			const c = this.s[this.i];
			if (c === undefined) return;
			if (/\s/.test(c) || c === ",") {
				this.i++;
				continue;
			}
			if (c === "#") {
				const nl = this.s.indexOf("\n", this.i);
				this.i = nl < 0 ? this.s.length : nl + 1;
				continue;
			}
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Schema walk
// ---------------------------------------------------------------------------

/** Strip list/non-null wrappers from a flattened type string → the named type. */
function namedType(flattened: string): string {
	return flattened.replace(/[[\]!]/g, "").trim();
}

/**
 * Decide whether an operation is a mutation by scanning past leading whitespace
 * and `#` comment lines to the first keyword. Linear scan (no backtracking regex)
 * so it can't ReDoS on adversarial input.
 */
export function isMutationOperation(query: string): boolean {
	let i = 0;
	const n = query.length;
	while (i < n) {
		const c = query[i];
		if (c === " " || c === "\t" || c === "\r" || c === "\n") {
			i++;
			continue;
		}
		if (c === "#") {
			const nl = query.indexOf("\n", i);
			if (nl < 0) return false;
			i = nl + 1;
			continue;
		}
		break;
	}
	return (
		query.startsWith("mutation", i) && !/[A-Za-z0-9_]/.test(query[i + 8] ?? "")
	);
}

/** A required arg is non-null (ends with `!`) with no default value. */
function isRequiredArg(arg: { type: string; defaultValue?: string }): boolean {
	return arg.type.trim().endsWith("!") && arg.defaultValue == null;
}

function fieldList(type: TrimmedType): string {
	const names = (type.fields ?? []).map((f) => f.name);
	if (names.length <= 12) return names.join(", ");
	return `${names.slice(0, 12).join(", ")}, … (+${names.length - 12} more)`;
}

function argList(def: TrimmedField): string {
	const args = def.args ?? [];
	if (args.length === 0) return "(takes no arguments)";
	return args.map((a) => `${a.name}: ${a.type}`).join(", ");
}

/**
 * Validate a GraphQL query against trimmed introspection. Conservative — see the
 * file header. Returns `{ checked: false }` whenever it can't reason confidently.
 */
export function validateGraphqlQuery(
	query: string,
	introspection: TrimmedIntrospection,
): GqlValidationResult {
	let root: ParsedField[];
	try {
		root = new SelectionParser(query).parse();
	} catch {
		return { checked: false, errors: [] };
	}

	const typeIndex = new Map<string, TrimmedType>();
	for (const t of introspection.types) typeIndex.set(t.name, t);

	const rootTypeName = isMutationOperation(query)
		? introspection.mutationType?.name
		: introspection.queryType.name;
	if (!rootTypeName || !typeIndex.has(rootTypeName)) {
		return { checked: false, errors: [] };
	}

	const errors: GqlValidationError[] = [];
	const MAX_ERRORS = 6;

	const walk = (selection: ParsedField[], typeName: string): void => {
		if (errors.length >= MAX_ERRORS) return;
		const type = typeIndex.get(typeName);
		// Unknown type, or a type with no field list (scalar/enum/union without
		// resolvable fields) → can't validate deeper. Be lenient, stop here.
		if (!type || !type.fields || type.fields.length === 0) return;
		const fieldIndex = new Map<string, TrimmedField>();
		for (const f of type.fields) fieldIndex.set(f.name, f);

		for (const sel of selection) {
			if (errors.length >= MAX_ERRORS) return;
			const def = fieldIndex.get(sel.name);
			if (!def) {
				errors.push({
					type: typeName,
					field: sel.name,
					message: `Field "${sel.name}" does not exist on type "${typeName}". Valid fields: ${fieldList(type)}.`,
				});
				continue; // can't resolve a return type for an unknown field
			}

			// Unknown / rejected arguments.
			if (sel.hasArgs && sel.args.length > 0) {
				const validArgs = new Set((def.args ?? []).map((a) => a.name));
				for (const argName of sel.args) {
					if (!validArgs.has(argName)) {
						errors.push({
							type: typeName,
							field: `${sel.name}.${argName}`,
							message: `Field "${sel.name}" on "${typeName}" does not accept argument "${argName}". Valid arguments: ${argList(def)}.`,
						});
					}
				}
			}

			// Missing required arguments.
			const provided = new Set(sel.args);
			for (const a of def.args ?? []) {
				if (isRequiredArg(a) && !provided.has(a.name)) {
					errors.push({
						type: typeName,
						field: `${sel.name}.${a.name}`,
						message: `Field "${sel.name}" on "${typeName}" requires argument "${a.name}: ${a.type}".`,
					});
				}
			}

			if (sel.selectionSet) walk(sel.selectionSet, namedType(def.type));
		}
	};

	walk(root, rootTypeName);
	return { checked: true, errors: errors.slice(0, MAX_ERRORS) };
}

/** One-line human summary of validation errors, for an error envelope message. */
export function formatGqlValidationErrors(
	errors: GqlValidationError[],
): string {
	return errors.map((e) => e.message).join(" ");
}
