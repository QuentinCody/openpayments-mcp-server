// interlinked-tdd: exempt -- re-export barrel, no testable surface
/** Monitoring primitive — public surface (engine + provenance ledger). */

export {
	canonicalValue,
	cleanResult,
	extractRowSets,
	KEY_SEP,
	keyedValueMap,
	type RowSet,
	reparse,
	resolvePath,
	rowKey,
	selectValueFields,
	snapshotHash,
} from "./canonicalize";
export { diffSnapshots, diffTable } from "./diff";
export {
	buildToolCall,
	callTool,
	type McpRpcResponse,
	type McpRpcStub,
	parseToolResult,
} from "./internal-call";
export { autoDetectKey, type KeyColumnStat } from "./key-detect";
export { classifyChanges, defaultMateriality } from "./materiality";
export {
	type QueryRunner,
	type RunOnceInput,
	type RunOnceResult,
	runOnce,
} from "./run-once";
export {
	appendSnapshot,
	buildSnapshotRow,
	type ChainVerifyResult,
	computeEntryHash,
	GENESIS_HASH,
	type SnapshotInput,
	type SnapshotRow,
	type SqlRunner,
	verifyChainRows,
	verifySnapshotChain,
} from "./snapshot-chain";
export { fdaOrangeBook, SOURCES } from "./sources/index";
export type {
	ChangeKind,
	FieldDelta,
	Materiality,
	MonitorProfile,
	RowChange,
	SavedQuery,
	SnapshotDiff,
	SourceModule,
	TableSpec,
	TableSummary,
} from "./types";
