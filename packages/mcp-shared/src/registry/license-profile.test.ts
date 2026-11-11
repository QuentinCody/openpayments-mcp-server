import { describe, expect, it } from "vitest";
import { adapterFailureMessage, type ApiFetchFn, commercialUseRefusal } from "../codemode/catalog";
import { createApiProxyTool } from "../tools/api-proxy";
import { createPaginateProxyTool } from "../tools/paginate-proxy";
import { getRequestCorrelation, getRequestLicenseProfile, LICENSE_PROFILE_META_KEY, nestedCallMeta } from "./request-scope";
import type { ToolContext } from "./types";

/**
 * The license profile travels: reselling caller -> `params._meta` -> server
 * request context -> the server's ApiFetchFn. It can only restrict a response.
 */
describe("license profile in request metadata", () => {
	it("reads the exact value 'commercial' from either metadata location", () => {
		expect(getRequestLicenseProfile({ _meta: { [LICENSE_PROFILE_META_KEY]: "commercial" } })).toBe("commercial");
		expect(getRequestLicenseProfile({ mcpReq: { _meta: { [LICENSE_PROFILE_META_KEY]: "commercial" } } })).toBe("commercial");
	});

	it("ignores every other value, and a missing key", () => {
		for (const value of ["Commercial", "free", "", true, 1, null, { a: 1 }]) {
			expect(getRequestLicenseProfile({ _meta: { [LICENSE_PROFILE_META_KEY]: value } })).toBeUndefined();
		}
		expect(getRequestLicenseProfile({ _meta: {} })).toBeUndefined();
		expect(getRequestLicenseProfile(undefined)).toBeUndefined();
	});

	it("is part of the request correlation, also with no chat id and no trace", () => {
		expect(getRequestCorrelation({ _meta: { [LICENSE_PROFILE_META_KEY]: "commercial" } })).toEqual({
			chatId: undefined,
			traceparent: undefined,
			licenseProfile: "commercial",
		});
		expect(getRequestCorrelation({ _meta: {} })).toBeUndefined();
	});

	it("is copied into the metadata of a nested call", () => {
		expect(nestedCallMeta({ licenseProfile: "commercial" })).toEqual({ [LICENSE_PROFILE_META_KEY]: "commercial" });
		expect(nestedCallMeta({ chatId: "c1" })).not.toHaveProperty(LICENSE_PROFILE_META_KEY);
	});
});

describe("license profile at the API adapter", () => {
	const seen: Array<Parameters<ApiFetchFn>[0]> = [];
	const apiFetch: ApiFetchFn = async (request) => {
		seen.push(request);
		if (request.licenseProfile === "commercial" && request.path.startsWith("/restricted")) {
			return commercialUseRefusal("The restricted route", "non-commercial terms");
		}
		return { status: 200, data: { ok: true } };
	};
	const proxy = createApiProxyTool({ apiFetch, stagingPrefix: "test" });
	const baseCtx: ToolContext = { sql: () => [] };
	const commercialCtx: ToolContext = { sql: () => [], requestContext: { licenseProfile: "commercial" } };

	it("passes the profile to the adapter only when the request has it", async () => {
		seen.length = 0;
		await proxy.handler({ method: "GET", path: "/open" }, baseCtx);
		await proxy.handler({ method: "GET", path: "/open" }, commercialCtx);
		expect(seen[0]).not.toHaveProperty("licenseProfile");
		expect(seen[1].licenseProfile).toBe("commercial");
	});

	it("reports the adapter's refusal as a failed call with the reason, and serves the same route without the profile", async () => {
		const refused = (await proxy.handler({ method: "GET", path: "/restricted/x" }, commercialCtx)) as Record<string, unknown>;
		expect(refused.__api_error).toBe(true);
		expect(refused.status).toBe(451);
		expect(JSON.stringify(refused)).toContain("NOT_LICENSED_FOR_COMMERCIAL_USE");
		const open = (await proxy.handler({ method: "GET", path: "/restricted/x" }, baseCtx)) as Record<string, unknown>;
		expect(open.__api_error).toBeUndefined();
	});

	it("puts the reason in the error message, so code that reads only the message sees why", async () => {
		const refused = (await proxy.handler({ method: "GET", path: "/restricted/x" }, commercialCtx)) as Record<string, unknown>;
		expect(refused.message).toBe(
			"NOT_LICENSED_FOR_COMMERCIAL_USE: The restricted route is not available in a commercial product: non-commercial terms",
		);
	});

	it("reports a refusal in a paged read as a failed call, not as zero records", async () => {
		const paged = createPaginateProxyTool({ apiFetch, stagingPrefix: "test" });
		const refused = (await paged.handler({ path: "/restricted/list", params: {}, opts: {} }, commercialCtx)) as Record<string, unknown>;
		expect(refused).toMatchObject({ __api_error: true, status: 451 });
		expect(String(refused.message)).toContain("NOT_LICENSED_FOR_COMMERCIAL_USE");
		const open = (await paged.handler({ path: "/restricted/list", params: {}, opts: {} }, baseCtx)) as Record<string, unknown>;
		expect(open.__api_error).toBeUndefined();
	});
});

describe("adapterFailureMessage", () => {
	it("keeps the generic text for every status that is not a license refusal", () => {
		expect(adapterFailureMessage(502, { error: "bad gateway" })).toBe("Upstream returned HTTP 502");
		expect(adapterFailureMessage(451, "blocked")).toBe("Upstream returned HTTP 451");
		expect(adapterFailureMessage(451, { error: "OTHER", message: "x" })).toBe("Upstream returned HTTP 451");
		expect(adapterFailureMessage(451, null)).toBe("Upstream returned HTTP 451");
	});
});

describe("commercialUseRefusal", () => {
	it("is HTTP 451 with a message that names the content and the terms", () => {
		expect(commercialUseRefusal("Full text", "about 29% of the open-access subset is non-commercial")).toEqual({
			status: 451,
			data: {
				error: "NOT_LICENSED_FOR_COMMERCIAL_USE",
				message: "Full text is not available in a commercial product: about 29% of the open-access subset is non-commercial",
			},
		});
	});
});
