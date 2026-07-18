// Unified tool registry

export type {
	ChartResponseOptions,
	ChartResponseResult,
	ChartSeries,
	ChartSpec,
	ChartType,
} from "./charting/index";
// Charting infrastructure
export {
	buildChartHtml,
	createChartResponse,
	renderUnicodeChart,
} from "./charting/index";
export { createEvaluator } from "./codemode/evaluator";
// GraphQL Code Mode infrastructure
export {
	createGraphqlExecuteTool,
	type GraphqlExecuteToolOptions,
	type GraphqlExecuteToolResult,
} from "./codemode/graphql-execute-tool";
export {
	fetchIntrospection,
	flattenTypeRef,
	type GraphqlFetchFn,
	INTROSPECTION_QUERY,
	type TrimmedField,
	type TrimmedIntrospection,
	type TrimmedType,
	trimIntrospectionResult,
} from "./codemode/graphql-introspection";
export { buildGraphqlProxySource } from "./codemode/graphql-proxy";
export { buildGraphqlSchemaSource } from "./codemode/graphql-schema-source";
export { introspectionToSummary } from "./codemode/graphql-to-typescript";
// Code Mode infrastructure
export { CodeModeProxy } from "./codemode/proxy";
// Code Mode response helpers
export {
	type CodeModeResponse,
	createCodeModeError,
	createCodeModeResponse,
	type ErrorCode,
	ErrorCodes,
	type ErrorResponse,
	type ResponseMeta,
	type SectionSource,
	type StructuredResponse,
	type SuccessResponse,
	withCodeMode,
} from "./codemode/response";
export { generateTypes } from "./codemode/types";
export {
	createVerifyCitationTool,
	type DriftSummary,
	registerVerifyCitationOnce,
	structuralDrift,
	type VerifyCitationSchema,
	type VerifyCitationToolResult,
} from "./codemode/verify-citation-tool";
// Completeness signal (machine-readable "is this the whole result?" verdict)
export {
	asCount,
	type Completeness,
	deriveMaterializationCompleteness,
	inferUpstreamTotal,
	mergeCompleteness,
	paginationCompleteness,
	type Truncation,
	type TruncationReason,
} from "./completeness";
// Entity types (cross-server entity resolution)
export type {
	ResolvedDisease,
	ResolvedDrug,
	ResolvedEntity,
	ResolvedGene,
	ResolvedProtein,
	ResolvedVariant,
} from "./entities/types";
// HTTP utilities
export {
	buildQueryString,
	type CacheOptions,
	type RateLimitPolicy,
	type RestFetchOptions,
	registerRateLimitPolicy,
	resetRateLimitState,
	restFetch,
} from "./http/rest-fetch";
export {
	buildPassthroughCitation,
	type PassthroughCitationArgs,
} from "./provenance/passthrough-citation";
export {
	buildJwks,
	CITATION_SIG_ALG,
	type CitationJwk,
	type CitationSigner,
	citationSigningInput,
	exportCitationPublicJwk,
	generateCitationKeypair,
	importCitationPrivateKey,
	importCitationPublicKey,
	type Jwks,
	signCitation,
	type SignatureVerdict,
	verifyCitationSignature,
} from "./provenance/signing";

// Provenance / citation (verifiable per-result source attribution)
export {
	type BuildCitationInput,
	buildCitation,
	type Citation,
	type CitationSignature,
	canonicalJson,
	type SourceDescriptor,
	sha256Hex,
	type VerifyResult,
	verifyCitation,
	verifyResultHash,
} from "./provenance/provenance";
export { type ToolDefinition, ToolRegistry } from "./registry/registry";
export { getRequestScope, type MaybeExtra } from "./registry/request-scope";
export type {
	SqlTaggedTemplate,
	ToolContext,
	ToolEntry,
} from "./registry/types";
// Staging infrastructure
export {
	ChunkingEngine,
	type ChunkMetadata,
	type SqlExec,
} from "./staging/chunking";
export { type InsertionResult, insertData } from "./staging/data-inserter";
export {
	CIVIC_CONFIG,
	DEFAULT_CONFIG,
	DGIDB_CONFIG,
	getDomainConfigByName,
	OPENTARGETS_CONFIG,
	RCSB_PDB_CONFIG,
} from "./staging/domain-config";
export {
	type DiscoveryResult,
	discoverEntities,
	inferEntityType,
	isEntity,
} from "./staging/entity-discovery";
export { NormalizationEngine } from "./staging/normalization-engine";
export {
	ensureIdColumn,
	findOriginalKey,
	getSQLiteType,
	hasScalarFields,
	isValidId,
	resolveColumnTypes,
	sanitizeColumnName,
	sanitizeTableName,
	singularize,
} from "./staging/normalizer";
export { RestStagingDO } from "./staging/rest-staging-do";
export { buildFallbackSchema, buildSchemas } from "./staging/schema-builder";
export {
	type ColumnProfile,
	computeColumnProfiles,
	detectArrays,
	type InferredColumn,
	type InferredSchema,
	type InferredTable,
	inferSchema,
	type MaterializationResult,
	type MaterializationWarning,
	materializeSchema,
	type SchemaHints,
	type TableProfile,
} from "./staging/schema-inference";
export { stageData } from "./staging/staging-engine";
// Staging metadata (universal staging awareness)
export {
	buildStagingMetadata,
	type StagingMetadata,
} from "./staging/staging-metadata";
// Consolidated staging engine (Tier 1 + Tier 2)
export type {
	DomainConfig,
	RelationshipMeta,
	SqlExec as StagingSqlExec,
	StagingContext,
	StagingHints,
	StagingResult,
	TableSchema,
} from "./staging/types";
export {
	createGetSchemaHandler,
	createQueryDataHandler,
	generateDataAccessId,
	getSchemaFromDo,
	queryDataFromDo,
	type StageOptions,
	type StageResult,
	type StagingProvenance,
	shouldStage,
	stageToDoAndRespond,
} from "./staging/utils";
export {
	storeWithVirtualColumns,
	type VirtualColumnResult,
} from "./staging/virtual-columns";
// Typed, contract-safe tool factory (Track E — invariants as types)
export {
	type DefineToolConfig,
	defineTool,
	type ToolContent,
	type ToolErr,
	type ToolErrOptions,
	type ToolHandler,
	type ToolHandlerExtra,
	type ToolOk,
	type ToolOkOptions,
	type ToolResult,
	toolErr,
	toolOk,
} from "./tools/define-tool";
export {
	DENIED_TABLES,
	directQueryTools,
	REDACTED_COLUMNS,
} from "./tools/direct-query";
export {
	createGraphqlProxyTool,
	type GraphqlErrorInfo,
	type GraphqlProxyToolOptions,
	inspectGraphqlErrors,
} from "./tools/graphql-proxy";
// Tool definitions
export { sqlTools } from "./tools/sql";
// SQL helpers
export { executeSql, isBlocked, isReadOnly } from "./tools/sql-helpers";
export { storeTools } from "./tools/store";
