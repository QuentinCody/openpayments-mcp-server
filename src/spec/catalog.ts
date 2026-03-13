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

export const openPaymentsCatalog: ApiCatalog = {
    name: "CMS Open Payments (DKAN)",
    baseUrl: "https://openpaymentsdata.cms.gov/api/1",
    version: "1.0",
    auth: "none",
    endpointCount: 6,
    notes:
        "## DKAN Query API\n" +
        "This API uses the DKAN open data platform. Each year/type of payment data is a separate dataset.\n" +
        "The primary query endpoint is `/datastore/query/{datasetId}/0` where `{datasetId}` is a UUID.\n\n" +
        "## How to Query Payments\n" +
        "1. Pick the dataset UUID from the registry below (or use `/search` to discover datasets)\n" +
        "2. Query via `/datastore/query/{datasetId}/0` with conditions and sorts\n" +
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
        "## Dataset UUID Registry\n" +
        "**General Payments** (physician non-research payments):\n" +
        "- 2024: `e6b17c6a-2534-4207-a4a1-6746a14911ff` (~15.4M records)\n" +
        "- 2023: `fb3a65aa-c901-4a38-a813-b04b00dfa2a9`\n" +
        "- 2022: `df01c2f8-dc1f-4e79-96cb-8208beaf143c`\n" +
        "- 2021: `0380bbeb-aea1-58b6-b708-829f92a48202`\n" +
        "- 2020: `a08c4b30-5cf3-4948-ad40-36f404619019`\n" +
        "- 2019: `4e54dd6c-30f8-4f86-86a7-3c109a89528e`\n" +
        "- 2018: `f003634c-c103-568f-876c-73017fa83be0`\n\n" +
        "**Research Payments** (clinical research/study payments):\n" +
        "- 2024: `2f15cb85-8887-4dcc-a318-1f8ec1d815b3` (~757K records)\n" +
        "- 2023: `ec9521bf-9d97-4603-814c-f4132d34bc4f`\n" +
        "- 2022: `fdc3c773-018a-412c-8a81-d7b8a13a037b`\n" +
        "- 2021: `ce1d28dd-0094-5060-a036-580329439600`\n" +
        "- 2020: `9c248e7e-7c7f-478b-ab84-ce0919d72c1c`\n" +
        "- 2019: `713a6016-1930-4a0c-b7c2-3e3de4f244c5`\n" +
        "- 2018: `7b82fb48-2bec-45f0-b40e-aed5f1d1eba0`\n\n" +
        "**Ownership/Investment Payments**:\n" +
        "- 2024: `9ac4f7f8-b6e4-4d80-8410-4aba7e71dd02` (~4.6K records)\n" +
        "- 2022: `37792388-800f-427a-9e02-b11601454eeb`\n" +
        "- 2019: `0b5c9710-7edb-484e-abc8-39293849ccb2`\n\n" +
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
        "- `record_id` — unique record identifier\n\n" +
        "## Key Columns — Research Payments (additional)\n" +
        "- `name_of_study` — research study name\n" +
        "- `clinicaltrials_gov_identifier` — NCT number link\n" +
        "- `research_information_link` — URL for research details\n" +
        "- `preclinical_research_indicator` — Yes/No\n" +
        "- Principal investigator fields (PI 1 has named columns; PIs 2-5 are collapsed during staging)\n\n" +
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
        // === Datastore Query ===
        {
            method: "GET",
            path: "/datastore/query/{datasetId}/0",
            summary:
                "Query a specific Open Payments dataset. This is the primary endpoint for retrieving payment records. " +
                "Use the dataset UUID registry (in notes) to find the right datasetId for each payment type and year. " +
                "Always pass keys=true and schema=false for optimal results.",
            category: "datastore",
            pathParams: [
                {
                    name: "datasetId",
                    type: "string",
                    required: true,
                    description:
                        "Dataset UUID — see Dataset UUID Registry in catalog notes for mapping of payment type + year to UUID",
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
                "including identifiers, titles, descriptions, and download URLs. Response is large (61+ datasets).",
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
