/**
 * Structured data storage tool for V8 isolates.
 *
 * Provides a `__store` hidden tool that accepts a table name + array of flat
 * objects, infers schema, creates/evolves the table, and batch-inserts rows.
 * Returns a small summary instead of the full dataset, keeping context window
 * usage minimal.
 *
 * Security layers:
 *   1. Table name validation (identifier regex, deny list, reserved prefixes)
 *   2. Column name validation (same identifier rules)
 *   3. Value type enforcement (scalars only — nested objects rejected with hints)
 *   4. Row/column count limits
 */
import type { ToolEntry } from "../registry/types";
export declare const storeTools: ToolEntry[];
//# sourceMappingURL=store.d.ts.map