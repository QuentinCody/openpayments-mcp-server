import { jsonByteSize, STAGING_THRESHOLD_BYTES, truncateUtf8 } from "../tools/passthrough-limits";
import type { ApiCatalog, ApiEndpoint, WorkflowRecipe } from "./catalog";
import { type CodeModeResponse, createCodeModeError, type ErrorResponse, type SuccessResponse } from "./response";
import { countByCategory, formatEndpoint, searchEndpoints } from "./search-core";

export interface CatalogSearchInput {
  query: string;
  category?: string;
  max_results?: number;
}

export interface DiscoveryData {
  total_endpoints: number;
  results_count: number;
  endpoints: ApiEndpoint[];
  total_workflows: number;
  workflows_count: number;
  workflows: WorkflowRecipe[];
  matched_endpoints: number;
  matched_workflows: number;
  omitted_endpoints: number;
  omitted_workflows: number;
  truncated: boolean;
  query: string;
  category: string | null;
  available_categories: Array<{ category: string; count: number }>;
}

export function discoveryCategories(catalog: ApiCatalog): Array<{ category: string; count: number }> {
  const categories = countByCategory(catalog);
  if (catalog.workflows?.length && !categories.some(item => item.category === "workflows")) {
    categories.push({ category: "workflows", count: catalog.workflows.length });
  }
  return categories;
}

function matchingWorkflows(workflows: WorkflowRecipe[], query: string): WorkflowRecipe[] {
  if (query === "*" || !query) return workflows;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return workflows.map(workflow => {
    const text = [workflow.title, workflow.description, ...workflow.keywords].join(" ").toLowerCase();
    return { workflow, score: tokens.filter(token => text.includes(token)).length };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.workflow);
}

function updateCounts(data: DiscoveryData): void {
  data.results_count = data.endpoints.length;
  data.workflows_count = data.workflows.length;
  data.omitted_endpoints = data.matched_endpoints - data.results_count;
  data.omitted_workflows = data.matched_workflows - data.workflows_count;
  data.truncated = data.omitted_endpoints + data.omitted_workflows > 0;
}

/** Keep whole entries under the inline budget; never return cut-off executable code. */
function appendWithinBudget<T>(data: DiscoveryData, output: T[], candidates: T[]): void {
  for (const item of candidates) {
    output.push(item);
    updateCounts(data);
    if (jsonByteSize({ success: true, data }) > STAGING_THRESHOLD_BYTES) output.pop();
  }
  updateCounts(data);
}

function selectDiscovery(catalog: ApiCatalog, input: CatalogSearchInput): DiscoveryData {
  const query = input.query?.trim() || "";
  const category = input.category?.trim().toLowerCase();
  const limit = Math.max(1, Math.min(Math.trunc(input.max_results || 10), 25));
  const endpoints = category ? catalog.endpoints.filter(ep => ep.category.toLowerCase() === category) : catalog.endpoints;
  const matches = query === "*" || !query ? endpoints : searchEndpoints(endpoints, query, endpoints.length);
  const workflows = !category || category === "workflows" ? matchingWorkflows(catalog.workflows || [], query) : [];
  const data: DiscoveryData = {
    total_endpoints: catalog.endpoints.length, results_count: 0, endpoints: [],
    total_workflows: catalog.workflows?.length || 0, workflows_count: 0, workflows: [],
    matched_endpoints: matches.length, matched_workflows: workflows.length,
    omitted_endpoints: matches.length, omitted_workflows: workflows.length, truncated: false,
    query, category: input.category ?? null, available_categories: discoveryCategories(catalog),
  };
  appendWithinBudget(data, data.endpoints, matches.slice(0, limit));
  appendWithinBudget(data, data.workflows, workflows.slice(0, limit));
  return data;
}

export function catalogDiscoveryResponse(catalog: ApiCatalog, input: CatalogSearchInput): CodeModeResponse<SuccessResponse<DiscoveryData> | ErrorResponse> {
  const data = selectDiscovery(catalog, input);
  if (jsonByteSize({ success: true, data }) > STAGING_THRESHOLD_BYTES ||
      (data.truncated && !data.results_count && !data.workflows_count)) {
    return createCodeModeError("DISCOVERY_RESPONSE_TOO_LARGE",
      "Matching catalog entries or search metadata exceed the inline discovery budget. No partial recipe code was returned. Narrow the query; an individually oversized entry requires a smaller catalog entry.");
  }
  const found = data.results_count + data.workflows_count;
  const heading = found
    ? `Found ${data.results_count} endpoint(s) and ${data.workflows_count} workflow(s) in ${truncateUtf8(catalog.name, 256)} API:`
    : `No endpoints found for "${truncateUtf8(data.query, 256)}"; no workflows matched. Try broader terms or browse the available categories.`;
  const sections = [heading, ...data.endpoints.map(formatEndpoint),
    ...data.workflows.map(workflow => `Workflow: ${workflow.title}\n${workflow.description}\n\n${workflow.code}`)];
  if (!found) sections.push(`Available categories:\n${data.available_categories.map(item => `${item.category} (${item.count})`).join("\n")}`);
  if (data.truncated) sections.push(`Results limited: ${data.omitted_endpoints} endpoint(s) and ${data.omitted_workflows} workflow(s) omitted by max_results or the inline byte budget. Narrow the query or use category='workflows' to retrieve recipes.`);
  return { content: [{ type: "text" as const, text: sections.join("\n\n") }], structuredContent: { success: true as const, data } };
}
