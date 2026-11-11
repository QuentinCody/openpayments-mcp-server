import { describe, expect, it } from "vitest";
import type { ApiCatalog, WorkflowRecipe } from "./catalog";
import { catalogDiscoveryResponse } from "./catalog-discovery";

const recipe: WorkflowRecipe = { title: "Compare two assemblies", description: "Preserve native coordinates", keywords: ["HPRC", "pangenome"], code: 'return await api.get("/getData/track", {genome:"hg38", track:"hprc2v21Sv"});' };
const catalog: ApiCatalog = { name: "Discovery fixture", baseUrl: "https://example.org", endpoints: [{ method: "GET", path: "/genes", summary: "Gene lookup", category: "genes" }], workflows: [recipe] };

describe("catalog workflow discovery", () => {
  it("returns an intact recipe for a keyword-only match with no matching endpoint", () => {
    const result = catalogDiscoveryResponse(catalog, { query: "PaNgEnOmE" });
    expect(result).toMatchObject({ structuredContent: { success: true, data: { results_count: 0, workflows_count: 1, workflows: [recipe], truncated: false } } });
    expect(result.content[0].text).toContain(recipe.code);
  });

  it("ranks workflow matches by title, description and keywords without searching executable code", () => {
    const second = { ...recipe, title: "HPRC assembly pangenome", keywords: [] };
    const result = catalogDiscoveryResponse({ ...catalog, workflows: [recipe, second] }, { query: "HPRC assembly pangenome", max_results: 1 });
    expect(result).toMatchObject({ structuredContent: { data: { workflows: [second], matched_workflows: 2, omitted_workflows: 1, truncated: true } } });
    expect(catalogDiscoveryResponse(catalog, { query: "api.get" })).toMatchObject({ structuredContent: { data: { workflows_count: 0 } } });
  });

  it("offers workflow-only browsing while keeping endpoint category filters scoped", () => {
    expect(catalogDiscoveryResponse(catalog, { query: "*", category: "WORKFLOWS" })).toMatchObject({ structuredContent: { data: { endpoints: [], workflows: [recipe] } } });
    expect(catalogDiscoveryResponse(catalog, { query: "*", category: "genes" })).toMatchObject({ structuredContent: { data: { endpoints: catalog.endpoints, workflows: [] } } });
  });

  it("keeps zero-match recovery hints and handles catalogs without recipes", () => {
    expect(catalogDiscoveryResponse({ ...catalog, workflows: undefined }, { query: "absent" })).toMatchObject({ structuredContent: { success: true, data: { endpoints: [], workflows: [], query: "absent", available_categories: [{ category: "genes", count: 1 }] } } });
    expect(catalogDiscoveryResponse(catalog, { query: "absent" })).toMatchObject({ structuredContent: { data: { available_categories: [{ category: "genes", count: 1 }, { category: "workflows", count: 1 }] } } });
  });

  it("limits each result kind and reports undisplayed matches", () => {
    const result = catalogDiscoveryResponse({ ...catalog, workflows: Array.from({ length: 30 }, (_, i) => ({ ...recipe, title: `Recipe ${i}` })) }, { query: "", max_results: 999 });
    expect(result).toMatchObject({ structuredContent: { data: { results_count: 1, workflows_count: 25, matched_workflows: 30, omitted_workflows: 5, truncated: true } } });
  });

  it("omits an oversized UTF-8 recipe whole, retains smaller matches, and never claims completeness", () => {
    const huge = { ...recipe, title: "Huge", code: `return "${"🧬".repeat(10_000)}";` };
    const result = catalogDiscoveryResponse({ ...catalog, workflows: [huge, recipe] }, { query: "*", category: "workflows" });
    expect(result).toMatchObject({ structuredContent: { success: true, data: { workflows: [recipe], omitted_workflows: 1, truncated: true } } });
    expect(new TextEncoder().encode(JSON.stringify(result.structuredContent)).length).toBeLessThanOrEqual(30 * 1024);
    expect(result.content[0].text).not.toContain("🧬");
  });

  it("returns both fields and isError when a sole match cannot fit", () => {
    const result = catalogDiscoveryResponse({ ...catalog, workflows: [{ ...recipe, code: "x".repeat(40_000) }] }, { query: "pangenome" });
    expect(result).toMatchObject({ isError: true, structuredContent: { success: false, error: { code: "DISCOVERY_RESPONSE_TOO_LARGE" } } });
    expect(result.content[0].text).toContain("No partial recipe code");
    expect(new TextEncoder().encode(JSON.stringify(result.structuredContent)).length).toBeLessThan(100_000);
  });

  it("fails explicitly for oversized search metadata and bounds endpoint bodies too", () => {
    expect(catalogDiscoveryResponse(catalog, { query: "x".repeat(40_000) })).toMatchObject({ isError: true });
    const oversized = { ...catalog.endpoints[0], description: "x".repeat(40_000) };
    expect(catalogDiscoveryResponse({ ...catalog, endpoints: [oversized] }, { query: "*" })).toMatchObject({ structuredContent: { data: { endpoints: [], workflows: [recipe], omitted_endpoints: 1 } } });
  });
});
