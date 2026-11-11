import type { ApiCatalog, ApiFetchFn } from "../codemode/catalog";
import type { ResolvedSpec } from "../codemode/openapi-resolver";

export interface ApiProxyToolOptions {
  apiFetch: ApiFetchFn;
  /** Optional legacy catalog metadata for drift hints */
  catalog?: ApiCatalog;
  /** Optional resolved OpenAPI metadata for drift hints */
  openApiSpec?: ResolvedSpec;
  /** DO namespace for auto-staging large responses */
  doNamespace?: unknown;
  /** Prefix for data access IDs (e.g., "gtex") */
  stagingPrefix?: string;
  /** Base byte threshold for auto-staging (default 30KB). */
  stagingThreshold?: number;
  /** Hard inline byte ceiling, including single records. Staging is mandatory above it. */
  maxInlineBytes?: number;
  /** Routes staging into the shared workspace when ctx.workspace is present. */
  workspaceNamespace?: unknown;
}
