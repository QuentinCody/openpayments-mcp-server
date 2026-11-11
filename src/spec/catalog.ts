/**
 * OpenPayments DKAN API catalog — hand-built from https://openpaymentsdata.cms.gov/about/api
 *
 * CMS Open Payments tracks payments from drug/device manufacturers to physicians
 * and teaching hospitals. Data is organized into per-year datasets across three types:
 * General Payments, Research Payments, and Ownership/Investment Payments.
 *
 * The API uses the DKAN open data platform. Each dataset is identified by a UUID.
 * Queries use the datastore endpoint with indexed array params for conditions/sorts.
 */

import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";
import { releaseEndpoints, releaseWorkflows } from "./releases";

export const openPaymentsCatalog: ApiCatalog = {
    name: "CMS Open Payments (DKAN)",
    baseUrl: "https://openpaymentsdata.cms.gov/api/1",
    version: "1.0",
    auth: "none",
    endpointCount: 9,
    workflows: releaseWorkflows,
    notes:
        "## DKAN Query API\n" +
        "This API uses the DKAN open data platform. Each year/type of payment data is a separate dataset.\n" +
        "The primary query endpoint is `/datastore/query/{datasetId}/0` where `{datasetId}` is a UUID.\n\n" +
        "## How to Query Payments\n" +
        "1. Use `/datasets/discover` with program_year and optional payment_type; choose among returned candidates explicitly.\n" +
        "2. Prefer `/datasets/{dataset_id}/page` to retain metadata and guard the selected year/type and revision. Native `/datastore/query/{datasetId}/0` remains available.\n" +
        "3. Always pass `keys: true` so results are objects (not arrays). Pass `schema: false` to keep responses small.\n\n" +
        "## Filtering Syntax\n" +
        "Pass `conditions` as an array of objects. Each condition has:\n" +
        "- `property`: column name (lowercase with underscores)\n" +
        "- `value`: value to match\n" +
        "- `operator`: `=`, `<>`, `<`, `>`, `<=`, `>=`, `LIKE`, `BETWEEN`, `IN`, `NOT IN`\n\n" +
        "For substring matching, use `LIKE` with `%` wildcards: `{ property: 'col', value: '%term%', operator: 'LIKE' }`\n" +
        "NOTE: `CONTAINS` and `STARTS_WITH` are NOT valid DKAN operators. Use `LIKE` with wildcards instead.\n" +
        "For prefix matching: `{ value: 'Pfizer%', operator: 'LIKE' }`\n\n" +
        "Example: `conditions: [{ property: 'recipient_state', value: 'TX', operator: '=' }]`\n\n" +
        "## IMPORTANT: Data Conventions\n" +
        "- **Names are UPPERCASE**: 'JOHN', 'SMITH', not 'John', 'Smith'\n" +
        "- **All values are strings**: amounts like '999.95' are TEXT, use CAST() for numeric sorting in staged SQL\n" +
        "- **Minimum limit is 1**: `limit: 0` is invalid, use `limit: 1` with `results: false` for count-only queries\n\n" +
        "## Performance Notes\n" +
        "- General payments have ~15M records per year. Queries filtering on unindexed or wide columns (manufacturer name, product name, NPI) may be slow or timeout.\n" +
        "- LIKE queries with leading wildcards (`%term%`) are very slow on large datasets — filter by state first to narrow results.\n" +
        "- Best-performing filters: `recipient_state`, `covered_recipient_type`, `nature_of_payment_or_transfer_of_value`\n" +
        "- For NPI lookups: consider using a smaller limit and narrowing by state if the query is slow.\n\n" +
        "## Sorting\n" +
        "Pass `sorts` as an array: `sorts: [{ property: 'total_amount_of_payment_usdollars', order: 'desc' }]`\n" +
        "NOTE: Sorts are lexicographic (string-based), so '999' > '9972' > '100000'. For true numeric sort, use staged SQL with CAST().\n\n" +
        "## Release and join provenance\n" +
        "Program year is the reporting period; issued/modified metadata, payment_publication_date and retrieval time are separate. CMS publishes the previous program year by June 30 and refreshes in January. Older years can also be revised.\n" +
        "Retain dataset UUID, distribution index/reference, metadata hash, program_year, record_id, change_type and dispute_status_for_publication. Metadata stability is not an atomic historical snapshot.\n" +
        "Join providers with NPI/profile ID and companies with manufacturer/GPO ID, preserving identity source and year. Do not merge by name alone or treat a payment/dispute as evidence of wrongdoing.\n" +
        "Do not assume archives remain queryable: CMS currently lists 2019–2025 in the search tool and 2013–2018 as archives. Discover the chosen year before using historical IDs.\n\n" +
        "**Covered Recipient Profile Supplement** (all years): `23160558-6742-54ff-8b9f-cac7d514ff4e`\n\n" +
        "## Key Columns — General Payments\n" +
        "- `covered_recipient_npi` — NPI number\n" +
        "- `covered_recipient_first_name` / `covered_recipient_last_name` — UPPERCASE\n" +
        "- `covered_recipient_profile_id` — CMS profile ID\n" +
        "- `covered_recipient_type` — 'Covered Recipient Physician', 'Covered Recipient Non-Physician Practitioner', 'Covered Recipient Teaching Hospital'\n" +
        "- `covered_recipient_primary_type_1` — e.g. 'Medical Doctor'\n" +
        "- `covered_recipient_specialty_1` — e.g. 'Allopathic & Osteopathic Physicians|Internal Medicine'\n" +
        "- `recipient_city`, `recipient_state`, `recipient_zip_code`, `recipient_country`\n" +
        "- `applicable_manufacturer_or_applicable_gpo_making_payment_name` — payer/manufacturer name\n" +
        "- `applicable_manufacturer_or_applicable_gpo_making_payment_id` — payer ID\n" +
        "- `total_amount_of_payment_usdollars` — payment amount (string, use CAST for numeric ops)\n" +
        "- `date_of_payment` — MM/DD/YYYY format\n" +
        "- `nature_of_payment_or_transfer_of_value` — e.g. 'Food and Beverage', 'Consulting Fee', 'Travel and Lodging', 'Royalty or License'\n" +
        "- `form_of_payment_or_transfer_of_value` — e.g. 'Cash or cash equivalent', 'In-kind items and services'\n" +
        "- `name_of_drug_or_biological_or_device_or_medical_supply_1` — associated product\n" +
        "- `physician_ownership_indicator` — Yes/No\n" +
        "- `program_year` — 4-digit year\n" +
        "- `record_id` — record identifier; retain year, dataset and revision context\n" +
        "- `payment_publication_date`, `change_type`, `dispute_status_for_publication` — retain native revision/dispute evidence\n\n" +
        "## Key Columns — Research Payments (additional)\n" +
        "- `name_of_study` — research study name\n" +
        "- `clinicaltrials_gov_identifier` — NCT number link\n" +
        "- `research_information_link` — URL for research details\n" +
        "- `preclinical_research_indicator` — Yes/No\n" +
        "- Principal investigator fields: release-page native envelope preserves all numbered fields; legacy wide-row staging may collapse PI 2-5\n\n" +
        "## Key Columns — Ownership Payments\n" +
        "- `physician_npi`, `physician_first_name`, `physician_last_name`\n" +
        "- `total_amount_invested_usdollars`\n" +
        "- `value_of_interest`, `terms_of_interest`\n" +
        "- `interest_held_by_physician_or_an_immediate_family_member`\n\n" +
        "## Pagination\n" +
        "- `limit`: 1–500 (default 500)\n" +
        "- `offset`: 0-based offset for pagination\n" +
        "- Set `count: true` to get total matching rows in response\n\n" +
        "## Response Format\n" +
        "Datastore queries return: `{ results: [...], count: N, schema: {...}, query: {...} }`\n" +
        "Always use `keys: true` so results are objects with named fields.\n" +
        "Use `schema: false` to avoid inflating the response size with column metadata.\n",
    endpoints: [
        ...releaseEndpoints,
        // === Datastore Query ===
        {
            method: "GET",
            path: "/datastore/query/{datasetId}/0",
            summary:
                "Query a specific Open Payments dataset. This is the primary endpoint for retrieving payment records. " +
                "Use /datasets/discover to find the datasetId for the reporting year and payment type. " +
                "Always pass keys=true and schema=false for optimal results.",
            category: "datastore",
            pathParams: [
                {
                    name: "datasetId",
                    type: "string",
                    required: true,
                    description:
                        "Dataset UUID — select from /datasets/discover for the requested payment type and reporting year",
                },
            ],
            queryParams: [
                {
                    name: "limit",
                    type: "number",
                    required: false,
                    description: "Max results per request (1-500, default 500). Minimum is 1.",
                    default: "500",
                },
                {
                    name: "offset",
                    type: "number",
                    required: false,
                    description: "Offset for pagination (default 0)",
                    default: "0",
                },
                {
                    name: "count",
                    type: "boolean",
                    required: false,
                    description: "Include total count of matching records in response",
                    default: "true",
                },
                {
                    name: "schema",
                    type: "boolean",
                    required: false,
                    description:
                        "Include column schema definitions in response. Set to false to keep response size small.",
                },
                {
                    name: "keys",
                    type: "boolean",
                    required: false,
                    description:
                        "When true, results are objects with named fields. When false, results are arrays. Always set to true.",
                },
                {
                    name: "results",
                    type: "boolean",
                    required: false,
                    description: "Include result rows (default true). Set to false for count-only queries.",
                    default: "true",
                },
                {
                    name: "conditions",
                    type: "array",
                    required: false,
                    description:
                        "Filter conditions — array of { property, value, operator }. " +
                        "Operators: =, <>, <, >, <=, >=, LIKE (use % wildcards), BETWEEN, IN, NOT IN. " +
                        "CONTAINS and STARTS_WITH are NOT valid — use LIKE with %wildcards% instead. " +
                        "Example: [{ property: 'recipient_state', value: 'TX', operator: '=' }]",
                },
                {
                    name: "sorts",
                    type: "array",
                    required: false,
                    description:
                        "Sort order — array of { property, order }. order: 'asc' or 'desc'. " +
                        "NOTE: sorts are lexicographic (string-based). " +
                        "Example: [{ property: 'total_amount_of_payment_usdollars', order: 'desc' }]",
                },
            ],
        },

        // === Search ===
        {
            method: "GET",
            path: "/search",
            summary:
                "Full-text search across all Open Payments datasets. Returns dataset metadata (titles, identifiers, descriptions). " +
                "Use this to discover datasets, then query specific ones via /datastore/query/{datasetId}/0. " +
                "Use single-word search terms for best results (e.g. 'general', 'research', 'ownership').",
            category: "search",
            queryParams: [
                {
                    name: "fulltext",
                    type: "string",
                    required: false,
                    description:
                        "Full-text search term. Use single words for best results: 'general', 'research', 'ownership'",
                },
                {
                    name: "facets",
                    type: "string",
                    required: false,
                    description: "Facet field to return counts for (e.g. 'keyword')",
                },
            ],
        },

        // === Metastore — Dataset Details ===
        {
            method: "GET",
            path: "/metastore/schemas/dataset/items/{identifier}",
            summary:
                "Get full metadata for a specific dataset by its UUID — title, description, temporal coverage, " +
                "distribution/download URLs, data dictionary reference, publisher, license.",
            category: "metastore",
            pathParams: [
                {
                    name: "identifier",
                    type: "string",
                    required: true,
                    description: "Dataset UUID identifier",
                },
            ],
        },

        // === Metastore — List All Datasets ===
        {
            method: "GET",
            path: "/metastore/schemas/dataset/items",
            summary:
                "List all available datasets in the Open Payments catalog. Returns metadata for every dataset " +
                "including identifiers, titles, descriptions, and download URLs. Response may require staging.",
            category: "metastore",
        },

        // === Data Dictionary ===
        {
            method: "GET",
            path: "/metastore/schemas/data-dictionary/items/{identifier}",
            summary:
                "Get the data dictionary (field definitions) for a dataset. Returns column names, " +
                "types, descriptions, and constraints. Use the describedBy URL from dataset metadata.",
            category: "metastore",
            pathParams: [
                {
                    name: "identifier",
                    type: "string",
                    required: true,
                    description: "Data dictionary UUID",
                },
            ],
        },

        // === Search Facets ===
        {
            method: "GET",
            path: "/search/facets",
            summary: "Get available facet filters and their values for dataset search.",
            category: "search",
        },
    ],
};
