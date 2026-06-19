/**
 * API drift detection for the `__api_proxy` tool.
 *
 * Extracted from `api-proxy.ts` (cohesive, self-contained, and the original file
 * was at the line cap). Given the server's known endpoints (catalog + OpenAPI
 * spec) and a failed request, {@link buildDriftHint} explains WHY it failed —
 * unknown endpoint, parameter mismatch, or an upstream contract change — so the
 * model can self-correct instead of blindly retrying.
 */

import type { ApiCatalog } from "../codemode/catalog";
import type { ResolvedSpec } from "../codemode/openapi-resolver";
import { isRecord } from "./api-proxy";

/** OpenAPI parameter object (subset of fields we inspect). */
interface SpecParameter {
	in?: string;
	name?: string;
}

type DriftHintKind =
	| "unknown_endpoint"
	| "contract_changed"
	| "parameter_mismatch";

export interface DriftHint {
	kind: DriftHintKind;
	message: string;
	suggestions?: Array<{ method: string; path: string; summary?: string }>;
	expected_params?: string[];
	known_methods?: string[];
}

export interface KnownEndpoint {
	method: string;
	path: string;
	summary?: string;
	pathParamNames: string[];
	queryParamNames: string[];
}

const HTTP_METHODS = new Set([
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"options",
	"head",
	"trace",
]);

function uniqueStrings(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function extractCatalogEndpoints(catalog?: ApiCatalog): KnownEndpoint[] {
	if (!catalog) return [];

	return catalog.endpoints.map((endpoint) => ({
		method: endpoint.method.toUpperCase(),
		path: endpoint.path,
		summary: endpoint.summary,
		pathParamNames: (endpoint.pathParams || []).map((param) => param.name),
		queryParamNames: (endpoint.queryParams || []).map((param) => param.name),
	}));
}

function extractSpecParamNames(
	params: SpecParameter[],
	location: "path" | "query",
): string[] {
	return uniqueStrings(
		params.flatMap((param) => {
			if (param.in !== location || typeof param.name !== "string") return [];
			return [param.name];
		}),
	);
}

function extractSpecEndpoints(spec?: ResolvedSpec): KnownEndpoint[] {
	if (!spec) return [];

	const endpoints: KnownEndpoint[] = [];
	for (const [path, pathItem] of Object.entries(spec.paths)) {
		if (!isRecord(pathItem)) continue;
		const pathParams: SpecParameter[] = Array.isArray(pathItem.parameters)
			? pathItem.parameters.filter(isRecord) as SpecParameter[]
			: [];

		for (const [method, operation] of Object.entries(pathItem)) {
			if (!HTTP_METHODS.has(method) || !isRecord(operation)) {
				continue;
			}

			const operationParams: SpecParameter[] = Array.isArray(operation.parameters)
				? operation.parameters.filter(isRecord) as SpecParameter[]
				: [];
			const mergedParams = [...pathParams, ...operationParams];

			endpoints.push({
				method: method.toUpperCase(),
				path,
				summary:
					typeof operation.summary === "string"
						? operation.summary
						: typeof operation.operationId === "string"
							? operation.operationId
							: undefined,
				pathParamNames: extractSpecParamNames(mergedParams, "path"),
				queryParamNames: extractSpecParamNames(mergedParams, "query"),
			});
		}
	}

	return endpoints;
}

export function buildKnownEndpointIndex(
	catalog?: ApiCatalog,
	openApiSpec?: ResolvedSpec,
): KnownEndpoint[] {
	const merged = new Map<string, KnownEndpoint>();

	for (const endpoint of [...extractCatalogEndpoints(catalog), ...extractSpecEndpoints(openApiSpec)]) {
		const key = `${endpoint.method} ${endpoint.path}`;
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, {
				...endpoint,
				pathParamNames: uniqueStrings(endpoint.pathParamNames),
				queryParamNames: uniqueStrings(endpoint.queryParamNames),
			});
			continue;
		}

		existing.summary ||= endpoint.summary;
		existing.pathParamNames = uniqueStrings([
			...existing.pathParamNames,
			...endpoint.pathParamNames,
		]);
		existing.queryParamNames = uniqueStrings([
			...existing.queryParamNames,
			...endpoint.queryParamNames,
		]);
	}

	return Array.from(merged.values());
}

function pathTemplateToRegExp(pathTemplate: string): RegExp {
	const escaped = pathTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\\\{[^}]+\\\}/g, "[^/]+")}$`);
}

function pathMatches(requestPath: string, endpointPath: string): boolean {
	return requestPath === endpointPath || pathTemplateToRegExp(endpointPath).test(requestPath);
}

function pathSegments(path: string): string[] {
	return path
		.split("/")
		.filter(Boolean)
		.map((segment) => segment.toLowerCase())
		.map((segment) => (segment.startsWith("{") && segment.endsWith("}") ? "{}" : segment));
}

function scoreSuggestion(
	requestPath: string,
	method: string,
	endpoint: KnownEndpoint,
): number {
	const requestSegments = pathSegments(requestPath);
	const endpointSegments = pathSegments(endpoint.path);
	let score = endpoint.method === method ? 10 : 0;

	const sharedPrefix = Math.min(requestSegments.length, endpointSegments.length);
	for (let i = 0; i < sharedPrefix; i++) {
		if (requestSegments[i] === endpointSegments[i]) {
			score += 4;
		} else if (requestSegments[i] === "{}" || endpointSegments[i] === "{}") {
			score += 2;
		} else {
			break;
		}
	}

	const overlap = requestSegments.filter((segment) => endpointSegments.includes(segment)).length;
	score += overlap;
	score -= Math.abs(requestSegments.length - endpointSegments.length);

	if (endpoint.path.includes("{") && pathMatches(requestPath, endpoint.path)) {
		score += 8;
	}

	return score;
}

function buildSuggestions(
	requestPath: string,
	method: string,
	knownEndpoints: KnownEndpoint[],
): Array<{ method: string; path: string; summary?: string }> {
	return knownEndpoints
		.map((endpoint) => ({
			endpoint,
			score: scoreSuggestion(requestPath, method, endpoint),
		}))
		.sort((left, right) => right.score - left.score)
		.slice(0, 3)
		.map(({ endpoint }) => ({
			method: endpoint.method,
			path: endpoint.path,
			...(endpoint.summary ? { summary: endpoint.summary } : {}),
		}));
}

export function buildDriftHint(
	method: string,
	requestPath: string,
	status: number,
	knownEndpoints: KnownEndpoint[],
): DriftHint | undefined {
	if (knownEndpoints.length === 0) return undefined;

	const normalizedMethod = method.toUpperCase();
	const exactMatches = knownEndpoints.filter(
		(endpoint) =>
			endpoint.method === normalizedMethod && pathMatches(requestPath, endpoint.path),
	);
	const pathMatchesAnyMethod = knownEndpoints.filter((endpoint) =>
		pathMatches(requestPath, endpoint.path),
	);

	if (exactMatches.length === 0) {
		const knownMethods = uniqueStrings(pathMatchesAnyMethod.map((endpoint) => endpoint.method));
		const suggestions = buildSuggestions(requestPath, normalizedMethod, knownEndpoints);
		const suggestionText = suggestions.length > 0
			? ` Try instead: ${suggestions
				.map((suggestion) => `${suggestion.method} ${suggestion.path}`)
				.join(", ")}.`
			: "";
		const methodText = knownMethods.length > 0
			? ` This path exists for methods: ${knownMethods.join(", ")}.`
			: "";

		return {
			kind: "unknown_endpoint",
			message:
				`Unknown endpoint: ${normalizedMethod} ${requestPath} does not exist.` +
				methodText +
				suggestionText,
			...(suggestions.length > 0 ? { suggestions } : {}),
			...(knownMethods.length > 0 ? { known_methods: knownMethods } : {}),
		};
	}

	const matchedEndpoint = exactMatches[0];
	const expectedParams = uniqueStrings([
		...matchedEndpoint.pathParamNames,
		...matchedEndpoint.queryParamNames,
	]);

	if ([400, 422].includes(status) && expectedParams.length > 0) {
		return {
			kind: "parameter_mismatch",
			message:
				`${normalizedMethod} ${matchedEndpoint.path} matches current metadata, but the API returned ${status}. ` +
				`Expected path/query params include: ${expectedParams.join(", ")}. ` +
				`Re-run getEndpoint(${JSON.stringify(matchedEndpoint.path)}, ${JSON.stringify(normalizedMethod)}) ` +
				`or describeEndpoint(...) to verify names and required fields.`,
			expected_params: expectedParams,
		};
	}

	if ([404, 405, 410, 501].includes(status)) {
		const knownMethods = uniqueStrings(pathMatchesAnyMethod.map((endpoint) => endpoint.method));
		const hasPathParams = matchedEndpoint.pathParamNames.length > 0;

		// 404 on a parameterized path (e.g. /studies/{id}) almost always means
		// the specific resource doesn't exist, not that the endpoint is broken.
		if (status === 404 && hasPathParams) {
			return {
				kind: "contract_changed",
				message:
					`Resource not found: the upstream API returned 404 for ${normalizedMethod} ${requestPath}. ` +
					`The endpoint ${matchedEndpoint.path} exists but the requested resource was not found in the database. ` +
					`Verify the identifier is correct and exists in this data source.`,
			};
		}

		// 405/410/501 or 404 on a fixed path — likely an API contract change
		return {
			kind: "contract_changed",
			message:
				`${normalizedMethod} ${matchedEndpoint.path} returned ${status}. ` +
				(status === 405
					? `Method ${normalizedMethod} may not be allowed.`
					: `The endpoint may have been removed or renamed.`) +
				(knownMethods.length > 0 ? ` Known methods for this path: ${knownMethods.join(", ")}.` : ""),
			...(knownMethods.length > 0 ? { known_methods: knownMethods } : {}),
		};
	}

	return undefined;
}
