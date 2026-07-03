# Openpayments MCP Server

This is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It lets MCP clients (Claude Desktop, Claude Code, Continue, etc.) query the upstream Openpayments API in natural language. It is one of 100+ servers in the [Bio MCP](../../README.md) monorepo.

## Connect

The server is deployed and ready at:

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

- `openpay_search` — discover available API operations (Code Mode catalog search, 6 endpoints)
- `openpay_execute` — **Code Mode**: write JavaScript in a V8 isolate (`api.get()` / `api.post()` / `searchSpec()`) instead of issuing tool calls one by one
- `openpay_query_data` — run SQL over large responses auto-staged into a per-session SQLite database
- `openpay_get_schema` — inspect the inferred schema of a staged dataset

Large responses (>30KB) are auto-staged into a queryable SQLite database; the tools return a `data_access_id` you can query with SQL.

Every tool returns both a human-readable `content` summary and a structured `structuredContent` payload.

## Development

```bash
./scripts/dev-servers.sh openpayments            # run locally (port 8824)
pnpm --filter openpayments-mcp-server run deploy   # deploy to Cloudflare Workers
```

See [`docs/adding-mcp-servers.md`](../../docs/adding-mcp-servers.md) and the root [README](../../README.md) for the full architecture (Code Mode, staging, portals).

---

*Auto-generated baseline README — refine with server-specific detail as needed.*
