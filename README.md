# Openpayments MCP Server

This is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It lets MCP clients (Claude Desktop, Claude Code, Continue, etc.) query the upstream Openpayments API in natural language. It is one of 100+ servers in the [Bio MCP](../../README.md) monorepo.

## Connect

The configured production endpoint is:

```
https://openpayments-mcp-server.quentincody.workers.dev/mcp
```

Add it to your MCP client (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "openpayments": {
      "command": "npx",
      "args": ["mcp-remote", "https://openpayments-mcp-server.quentincody.workers.dev/mcp"]
    }
  }
}
```

For local development the server runs at `http://localhost:8824/mcp` (start it with `./scripts/dev-servers.sh openpayments`):

```json
{
  "mcpServers": {
    "openpayments-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8824/mcp"]
    }
  }
}
```

## Tools

- `openpay_search` — discover available API operations (Code Mode catalog search, 9 endpoints)
- `openpay_execute` — **Code Mode**: read the public API with JavaScript in a V8 isolate (`api.get()` / `searchSpec()`)
- `openpay_query_data` — run SQL over large responses auto-staged into a per-session SQLite database
- `openpay_get_schema` — inspect the inferred schema of a staged dataset

Large responses (>30KB) are auto-staged into a queryable SQLite database; the tools return a `data_access_id` you can query with SQL.

Every tool returns both a human-readable `content` summary and a structured `structuredContent` payload.

All four tools also register their `mcp_openpay_*` aliases.

## Reporting-year discovery and revision-aware reads

CMS now publishes [program-year 2025 data](https://www.cms.gov/priorities/key-initiatives/open-payments/data),
covering payments reported for 2025 with initial publication in 2026. The catalog
uses runtime discovery instead of recommending a registry that stopped at 2024:

- `GET /datasets/discover` requires `program_year` and optionally
  `payment_type` (`general`, `research`, `ownership`). It reads current DKAN
  metadata and returns all matching detailed-payment datasets, native metadata,
  distribution references and metadata hashes. It does not pick a latest dataset
  or substitute aggregate totals when detailed records are absent.
- `GET /datasets/{dataset_id}/metadata` returns full metadata and its hash.
- `GET /datasets/{dataset_id}/page` requires the reporting year and payment type.
  It checks dataset identity, each row's program year, and metadata before/after
  the read. Supply `expected_metadata_sha256` to pin the selection; it is required
  when `offset` is positive. Select `distribution_index` explicitly if there are
  multiple distributions. The default is 50 rows, with a maximum of 500, ordered
  by native `record_id`.

The page helper returns `{ native, metadata, _openpayments }`. Preserve native
`program_year`, `record_id`, `payment_publication_date`, `change_type` and dispute
fields alongside dataset/distribution identity. `issued`, `modified`, reporting
year and retrieval time are separate evidence. Stable metadata does not make a
multi-page query an atomic historical snapshot; an empty filtered page does not
establish absence. Provider and company joins should use NPI/profile and
manufacturer/GPO identifiers with source/year context, rather than names alone.

Full native rows and response envelopes survive staging, including numbered
investigator/product fields, blanks, identifier zeros and decimal strings.
`payments`, `research_payments` and `ownership_payments` expose native columns.
Wide rows use groups of at most 80 native columns; join the base table to its
`_columns_2`, `_columns_3`, etc. tables using `source_path`. The base table's
`native_json` retains the complete row. `response_context.native_json` retains
the complete native envelope; `payloads` retains canonical citation evidence.
Schema definitions are not payment rows. Use `openpay_get_schema` before SQL.
Select the needed columns when joining wide tables: the Workerd SQLite limit
also applies to result-set columns, so `SELECT *` across all groups can fail.

Every tool has verifiable citations and full-response staging above 30 KiB,
including errors and large SQL/schema responses. Native error bodies retain
their source URL, status and hash. Guarded pages also carry a response hash.
Existing raw DKAN routes and their filtered-empty guard remain available.
Metadata lists cap at 16 MiB and other reads at 4 MiB; a single raw read has a
45-second header/body deadline. Broad sorted general-payment queries may exceed
that deadline; use narrower native conditions. Redirects are rejected.

October 4 native reads confirmed all three 2025 detailed datasets with
`issued`/`modified` of `2026-06-30`. Local acceptance uses live public HTTPS reads
through a Node transport: direct local Workerd requests receive an Akamai 403.
This local transport limitation remains unresolved. A read-only probe of the
existing production server succeeds; these changes remain undeployed. Fixtures
and local acceptance do not establish complete dataset coverage or a deployment.
See the [dated review](../../docs/audits/2026-10-04-openpayments-review.md) and
[DKAN reference](https://dkan.readthedocs.io/en/2.x/user-guide/guide_api.html).

## Development

```bash
./scripts/dev-servers.sh openpayments            # run locally (port 8824)
pnpm --filter openpayments-mcp-server run deploy   # deploy to Cloudflare Workers
```

See [`docs/adding-mcp-servers.md`](../../docs/adding-mcp-servers.md) and the root [README](../../README.md) for the full architecture (Code Mode, staging, portals).

---

*Auto-generated baseline README — refine with server-specific detail as needed.*

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from CMS Open Payments and stays under the terms of that source: US public domain.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
