// GraphQL introspection → ApiCatalog (Tier 3), extracted from
// catalog-generator.ts (which re-exports graphQlToCatalog for compatibility).
// Each query becomes a virtual endpoint on POST /graphql; arguments map to
// queryParams for discoverability.
import type { ApiCatalog, ApiEndpoint, ParamDef } from "./catalog";
import type {
	CatalogDiagnostic,
	CatalogGeneratorResult,
	GraphQlToCatalogOptions,
} from "./catalog-generator";

interface GqlTypeRef {
	kind: string;
	name?: string | null;
	ofType?: GqlTypeRef | null;
}

interface GqlArg {
	name: string;
	description?: string | null;
	type: GqlTypeRef;
	defaultValue?: string | null;
}

interface GqlField {
	name: string;
	description?: string | null;
	args: GqlArg[];
	type: GqlTypeRef;
	isDeprecated?: boolean;
}

function unwrapGqlType(type: GqlTypeRef): {
	typeName: string;
	required: boolean;
	isList: boolean;
} {
	let required = false;
	let isList = false;
	let current = type;

	if (current.kind === "NON_NULL") {
		required = true;
		current = current.ofType || current;
	}
	if (current.kind === "LIST") {
		isList = true;
		current = current.ofType || current;
		if (current.kind === "NON_NULL") {
			current = current.ofType || current;
		}
	}

	return { typeName: current.name || "any", required, isList };
}

function gqlTypeToParamType(type: GqlTypeRef): ParamDef["type"] {
	const { typeName, isList } = unwrapGqlType(type);
	if (isList) return "array";
	switch (typeName) {
		case "Int":
		case "Float":
			return "number";
		case "Boolean":
			return "boolean";
		default:
			return "string";
	}
}

function gqlTypeToShapeString(type: GqlTypeRef): string {
	const { typeName, isList } = unwrapGqlType(type);
	const scalar =
		typeName === "Int" || typeName === "Float"
			? "number"
			: typeName === "Boolean"
				? "boolean"
				: typeName === "String" || typeName === "ID"
					? "string"
					: typeName;
	return isList ? `Array<${scalar}>` : scalar;
}

/**
 * Convert a GraphQL introspection result to an ApiCatalog.
 * Each query becomes a virtual GET endpoint, each mutation a POST endpoint.
 * Arguments are mapped to queryParams for discoverability.
 */
export function graphQlToCatalog(
	introspection: unknown,
	options: GraphQlToCatalogOptions,
): CatalogGeneratorResult {
	const diagnostics: CatalogDiagnostic[] = [];
	const endpoints: ApiEndpoint[] = [];

	// Navigate to __schema
	const root = introspection as Record<string, unknown>;
	const schema =
		(root.__schema as Record<string, unknown>) ||
		((root.data as Record<string, unknown>)?.__schema as Record<
			string,
			unknown
		>);

	if (!schema) {
		return {
			catalog: {
				name: options.name,
				baseUrl: options.baseUrl,
				endpointCount: 0,
				endpoints: [],
			},
			diagnostics: [
				{
					level: "error",
					message: "No __schema found in introspection result",
				},
			],
		};
	}

	const types = schema.types as Array<Record<string, unknown>> | undefined;
	if (!types) {
		return {
			catalog: {
				name: options.name,
				baseUrl: options.baseUrl,
				endpointCount: 0,
				endpoints: [],
			},
			diagnostics: [{ level: "error", message: "No types found in schema" }],
		};
	}

	const queryTypeName = (
		schema.queryType as Record<string, unknown> | undefined
	)?.name as string | undefined;
	const mutationTypeName = (
		schema.mutationType as Record<string, unknown> | undefined
	)?.name as string | undefined;

	// Process queries
	if (queryTypeName) {
		const queryType = types.find((t) => t.name === queryTypeName);
		const fields = queryType?.fields as GqlField[] | undefined;
		if (fields) {
			for (const field of fields) {
				if (field.name.startsWith("__")) continue; // Skip introspection fields
				const queryParams =
					field.args.length > 0
						? field.args.map(
								(arg): ParamDef => ({
									name: arg.name,
									type: gqlTypeToParamType(arg.type),
									required: unwrapGqlType(arg.type).required,
									description: arg.description || arg.name,
									...(arg.defaultValue != null
										? { default: arg.defaultValue }
										: {}),
								}),
							)
						: undefined;

				const requiredArgs = field.args
					.filter((a) => unwrapGqlType(a.type).required)
					.map((a) => `${a.name}: $${a.name}`)
					.join(", ");

				endpoints.push({
					method: "POST",
					path: "/graphql",
					summary: `Query: ${field.name}${field.description ? ` — ${field.description}` : ""}`,
					...(field.description ? { description: field.description } : {}),
					category: "queries",
					...(queryParams ? { queryParams } : {}),
					body: {
						contentType: "application/json",
						description: "GraphQL query",
					},
					responseShape: gqlTypeToShapeString(field.type),
					usageHint: `api.post('/graphql', { query: '{ ${field.name}${requiredArgs ? `(${requiredArgs})` : ""} { ... } }' })`,
					...(field.isDeprecated ? { deprecated: true } : {}),
				});
			}
		}
	}

	// Process mutations
	if (mutationTypeName) {
		const mutationType = types.find((t) => t.name === mutationTypeName);
		const fields = mutationType?.fields as GqlField[] | undefined;
		if (fields) {
			for (const field of fields) {
				if (field.name.startsWith("__")) continue;
				endpoints.push({
					method: "POST",
					path: "/graphql",
					summary: `Mutation: ${field.name}${field.description ? ` — ${field.description}` : ""}`,
					...(field.description ? { description: field.description } : {}),
					category: "mutations",
					body: {
						contentType: "application/json",
						description: "GraphQL mutation",
					},
					responseShape: gqlTypeToShapeString(field.type),
					...(field.isDeprecated ? { deprecated: true } : {}),
				});
			}
		}
	}

	if (endpoints.length === 0) {
		diagnostics.push({
			level: "warn",
			message: "No queries or mutations found in schema",
		});
	}

	const catalog: ApiCatalog = {
		name: options.name,
		baseUrl: options.baseUrl,
		endpointCount: endpoints.length,
		...(options.auth ? { auth: options.auth } : {}),
		notes:
			options.notes ||
			"GraphQL API. All operations use POST /graphql with { query: '...' } body. " +
				"Use api.post('/graphql', { query: '...' }) in Code Mode.",
		endpoints,
	};

	return { catalog, diagnostics };
}
