import { describe, expect, it } from "vitest";
import {
	ensureIntrospectionCached,
	type IntrospectionCache,
	registerGraphqlSearchTool,
	SCHEMA_DISCOVERY_UNAVAILABLE,
} from "./graphql-schema-discovery";

// A gqlFetch that answers the introspection query the way Apollo does with
// `introspection: false` (as NCI PDC's production server does): errors, no data.
const introspectionDisabled = async () => ({
	errors: [
		{ message: "GraphQL introspection is not allowed by Apollo Server" },
	],
});

const introspectionOk = async () => ({
	data: { __schema: { queryType: { name: "Query" }, types: [] } },
});

describe("ensureIntrospectionCached", () => {
	it("fills the cache when introspection succeeds", async () => {
		const cache: IntrospectionCache = { introspection: undefined };
		await ensureIntrospectionCached(cache, introspectionOk);
		expect(cache.introspection).toBeDefined();
		expect(cache.introspectionUnavailable).toBeUndefined();
	});

	it("flags unavailable instead of throwing when introspection is disabled", async () => {
		const cache: IntrospectionCache = { introspection: undefined };
		await ensureIntrospectionCached(cache, introspectionDisabled);
		expect(cache.introspection).toBeUndefined();
		expect(cache.introspectionUnavailable).toBe(true);
	});

	it("does not re-fetch once flagged unavailable", async () => {
		const cache: IntrospectionCache = {
			introspection: undefined,
			introspectionUnavailable: true,
		};
		let calls = 0;
		await ensureIntrospectionCached(cache, async () => {
			calls++;
			return { data: { __schema: { queryType: { name: "Query" }, types: [] } } };
		});
		expect(calls).toBe(0);
	});
});

describe("registerGraphqlSearchTool degradation", () => {
	function grabHandler(cache: IntrospectionCache, gqlFetch: () => Promise<unknown>) {
		let handler:
			| ((i: { query?: string }) => Promise<unknown>)
			| undefined;
		registerGraphqlSearchTool(
			{
				tool: (...args: unknown[]) => {
					handler = args[3] as typeof handler;
				},
			},
			{
				prefix: "pdc",
				apiName: "NCI PDC",
				gqlFetch: gqlFetch as never,
				cache,
			},
		);
		if (!handler) throw new Error("search handler not registered");
		return handler;
	}

	it("returns schema_available:false with guidance when introspection is disabled", async () => {
		const handler = grabHandler(
			{ introspection: undefined },
			introspectionDisabled,
		);
		const res = (await handler({ query: "case" })) as {
			content: Array<{ text: string }>;
			structuredContent: { schema_available?: boolean; success?: boolean };
		};
		expect(res.structuredContent.success).toBe(true);
		expect(res.structuredContent.schema_available).toBe(false);
		expect(res.content[0].text).toBe(SCHEMA_DISCOVERY_UNAVAILABLE);
	});
});

describe("registerGraphqlSearchTool catalog fallback", () => {
	const catalog: import("./catalog").ApiCatalog = {
		name: "NCI PDC",
		baseUrl: "https://example.test/graphql",
		endpointCount: 2,
		endpoints: [
			{
				method: "POST",
				path: "/graphql",
				summary: "List cases in a program",
				category: "queries",
				queryParams: [
					{
						name: "program",
						type: "string",
						required: false,
						description: "program name",
					},
				],
				usageHint: "gql.query('{ case { case_id } }')",
			},
			{
				method: "POST",
				path: "/graphql",
				summary: "Study metadata",
				category: "queries",
				featured: true,
			},
		],
	};

	function grabHandler(
		cache: IntrospectionCache,
		gqlFetch: () => Promise<unknown>,
		cat?: typeof catalog,
	) {
		let handler:
			| ((i: { query?: string; max_results?: number }) => Promise<unknown>)
			| undefined;
		registerGraphqlSearchTool(
			{
				tool: (...args: unknown[]) => {
					handler = args[3] as typeof handler;
				},
			},
			{
				prefix: "pdc",
				apiName: "NCI PDC",
				gqlFetch: gqlFetch as never,
				cache,
				catalog: cat,
			},
		);
		if (!handler) throw new Error("search handler not registered");
		return handler;
	}

	it("searches the static catalog when introspection is disabled", async () => {
		const handler = grabHandler(
			{ introspection: undefined },
			introspectionDisabled,
			catalog,
		);
		const res = (await handler({ query: "case" })) as {
			content: Array<{ text: string }>;
			structuredContent: {
				schema_available?: boolean;
				success?: boolean;
				source?: string;
			};
		};
		expect(res.structuredContent.success).toBe(true);
		expect(res.structuredContent.schema_available).toBe(false);
		expect(res.structuredContent.source).toBe("catalog");
		expect(res.content[0].text).toContain("List cases in a program");
		expect(res.content[0].text).not.toBe(SCHEMA_DISCOVERY_UNAVAILABLE);
	});

	it("browses featured endpoints on an empty query", async () => {
		const handler = grabHandler(
			{ introspection: undefined },
			introspectionDisabled,
			catalog,
		);
		const res = (await handler({ query: "" })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain("Study metadata");
	});

	it("still returns the unavailable note (no source) with no catalog", async () => {
		const handler = grabHandler(
			{ introspection: undefined },
			introspectionDisabled,
		);
		const res = (await handler({ query: "case" })) as {
			content: Array<{ text: string }>;
			structuredContent: { source?: string };
		};
		expect(res.content[0].text).toBe(SCHEMA_DISCOVERY_UNAVAILABLE);
		expect(res.structuredContent.source).toBeUndefined();
	});
});
