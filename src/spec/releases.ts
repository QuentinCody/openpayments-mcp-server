import type { ApiEndpoint, WorkflowRecipe } from "@bio-mcp/shared/codemode/catalog";

export const releaseEndpoints: ApiEndpoint[] = [
  {
    method: "GET", path: "/datasets/discover", category: "releases", featured: true,
    summary: "Discover detailed-payment datasets by program year and payment type from current metadata. Returns all matching candidates and native publication/revision/distribution evidence; never silently picks latest.",
    queryParams: [
      { name: "program_year", type: "number", required: true, description: "Reporting year, e.g. 2025. Not publication year (2025 data was first published in 2026)." },
      { name: "payment_type", type: "string", required: false, description: "general, research, or ownership; omitted returns all three." },
    ],
  },
  {
    method: "GET", path: "/datasets/{dataset_id}/metadata", category: "releases",
    summary: "Read current native metadata with reference identifiers, canonical metadata hash and title-derived reporting-year/type identity. Distribution indices follow array order; metadata is not an immutable snapshot.",
    pathParams: [{ name: "dataset_id", type: "string", required: true, description: "Exact dataset UUID returned by discovery." }],
  },
  {
    method: "GET", path: "/datasets/{dataset_id}/page", category: "releases", featured: true,
    summary: "Bounded full-row payment page guarded by metadata before/after reads and explicit program-year/type checks. Preserves all native revision/dispute/publication fields, strings and IDs. Default order is record_id ascending.",
    pathParams: [{ name: "dataset_id", type: "string", required: true, description: "Exact dataset UUID selected from discovery." }],
    queryParams: [
      { name: "program_year", type: "number", required: true, description: "Reporting year that must agree with dataset title and every returned row." },
      { name: "payment_type", type: "string", required: true, description: "general, research, or ownership." },
      { name: "distribution_index", type: "number", required: false, description: "Zero-based metadata distribution index. Required when multiple distributions exist." },
      { name: "expected_metadata_sha256", type: "string", required: false, description: "Pin metadata hash from discovery/metadata/previous page. Required when offset > 0; changed metadata returns 409." },
      { name: "limit", type: "number", required: false, description: "1–500 rows; default 50." },
      { name: "offset", type: "number", required: false, description: "0–100000000; default 0. Continuation requires the same metadata hash." },
      { name: "conditions", type: "array", required: false, description: "Up to 20 simple DKAN conditions with lowercase property, string value and =, <>, <, >, <=, >= or LIKE. No projection; all row evidence is retained." },
    ],
  },
];

export const releaseWorkflows: WorkflowRecipe[] = [{
  title: "Discover 2025 research payments with publication provenance",
  description: "Find the program-year dataset at runtime and read a small version-guarded page. Retain covered-recipient/manufacturer/PI identifiers and NCT IDs for subsequent provider/company/trial joins; names alone are not join keys.",
  keywords: ["2025", "research", "program year", "publication", "revision", "provider", "company"],
  code: `const found = await api.get('/datasets/discover', { program_year: 2025, payment_type: 'research' });
if (found.__staged || found.__api_error) return found;
if (found.candidates.length !== 1) throw new Error('Choose a dataset explicitly from the discovery candidates');
const selected = found.candidates[0];
if (selected.metadata.distribution.length !== 1) throw new Error('Inspect metadata and choose a distribution explicitly');
return await api.get('/datasets/' + selected.dataset_id + '/page', {
  program_year: 2025, payment_type: 'research', distribution_index: 0,
  expected_metadata_sha256: selected.metadata_sha256, limit: 10
});`,
}];
