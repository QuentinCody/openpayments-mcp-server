// Unified tool registry
export { ToolRegistry, type ToolDefinition } from "./registry/registry";
export type { ToolEntry, ToolContext, SqlTaggedTemplate } from "./registry/types";

// Tool definitions
export { sqlTools } from "./tools/sql";
export { directQueryTools, DENIED_TABLES, REDACTED_COLUMNS } from "./tools/direct-query";
export { storeTools } from "./tools/store";

// SQL helpers
export { isReadOnly, isBlocked, executeSql } from "./tools/sql-helpers";

// Code Mode infrastructure
export { CodeModeProxy } from "./codemode/proxy";
export { createEvaluator } from "./codemode/evaluator";
export { generateTypes } from "./codemode/types";

// GraphQL Code Mode infrastructure
export {
	createGraphqlExecuteTool,
	type GraphqlExecuteToolOptions,
	type GraphqlExecuteToolResult,
} from "./codemode/graphql-execute-tool";
export {
	fetchIntrospection,
	trimIntrospectionResult,
	flattenTypeRef,
	INTROSPECTION_QUERY,
	type GraphqlFetchFn,
	type TrimmedIntrospection,
	type TrimmedType,
	type TrimmedField,
} from "./codemode/graphql-introspection";
export { buildGraphqlSchemaSource } from "./codemode/graphql-schema-source";
export { buildGraphqlProxySource } from "./codemode/graphql-proxy";
export { introspectionToSummary } from "./codemode/graphql-to-typescript";
export { createGraphqlProxyTool, type GraphqlProxyToolOptions } from "./tools/graphql-proxy";

// Code Mode response helpers
export {
	createCodeModeResponse,
	createCodeModeError,
	withCodeMode,
	ErrorCodes,
	type CodeModeResponse,
	type SuccessResponse,
	type ErrorResponse,
	type StructuredResponse,
	type ErrorCode,
} from "./codemode/response";

// Staging metadata (universal staging awareness)
export {
	buildStagingMetadata,
	type StagingMetadata,
} from "./staging/staging-metadata";

// Staging infrastructure
export { ChunkingEngine, type ChunkMetadata, type SqlExec } from "./staging/chunking";
export {
	detectArrays,
	inferSchema,
	materializeSchema,
	computeColumnProfiles,
	type SchemaHints,
	type InferredColumn,
	type InferredTable,
	type InferredSchema,
	type MaterializationResult,
	type MaterializationWarning,
	type ColumnProfile,
	type TableProfile,
} from "./staging/schema-inference";
export { RestStagingDO } from "./staging/rest-staging-do";
export {
	shouldStage,
	generateDataAccessId,
	stageToDoAndRespond,
	queryDataFromDo,
	getSchemaFromDo,
	createQueryDataHandler,
	createGetSchemaHandler,
	type StageResult,
	type StagingProvenance,
} from "./staging/utils";

// Consolidated staging engine (Tier 1 + Tier 2)
export type {
	TableSchema,
	RelationshipMeta,
	StagingContext,
	StagingHints,
	StagingResult,
	DomainConfig,
	SqlExec as StagingSqlExec,
} from "./staging/types";
export {
	sanitizeTableName,
	sanitizeColumnName,
	singularize,
	getSQLiteType,
	resolveColumnTypes,
	ensureIdColumn,
	hasScalarFields,
	findOriginalKey,
	isValidId,
} from "./staging/normalizer";
export {
	DEFAULT_CONFIG,
	CIVIC_CONFIG,
	DGIDB_CONFIG,
	OPENTARGETS_CONFIG,
	RCSB_PDB_CONFIG,
	getDomainConfigByName,
} from "./staging/domain-config";
export {
	isEntity,
	inferEntityType,
	discoverEntities,
	type DiscoveryResult,
} from "./staging/entity-discovery";
export { buildSchemas, buildFallbackSchema } from "./staging/schema-builder";
export { insertData, type InsertionResult } from "./staging/data-inserter";
export { storeWithVirtualColumns, type VirtualColumnResult } from "./staging/virtual-columns";
export { NormalizationEngine } from "./staging/normalization-engine";
export { stageData } from "./staging/staging-engine";

// Entity types (cross-server entity resolution)
export type {
	ResolvedGene,
	ResolvedDrug,
	ResolvedDisease,
	ResolvedProtein,
	ResolvedVariant,
	ResolvedEntity,
} from "./entities/types";

// HTTP utilities
export { restFetch, buildQueryString, type RestFetchOptions } from "./http/rest-fetch";

// Charting infrastructure
export { createChartResponse, renderUnicodeChart, buildChartHtml } from "./charting/index";
export type {
	ChartSpec,
	ChartType,
	ChartSeries,
	ChartResponseOptions,
	ChartResponseResult,
} from "./charting/index";
