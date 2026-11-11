import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { inspectStagedTables } from "./schema-inspection";
import { buildRelationshipJoins } from "./schema-response";

it("inspects hyphenated and quoted native table names with exact counts and descriptors", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const statement of ['CREATE TABLE "cell_lines_xref-list" (accession TEXT NOT NULL)', 'INSERT INTO "cell_lines_xref-list" VALUES (\'0001\'), (\'0020\')', 'CREATE TABLE "pub""refs" (_rowid INTEGER PRIMARY KEY, "native-field" TEXT)', 'INSERT INTO "pub""refs" VALUES (1, \'kept\')', 'CREATE TABLE _column_profiles (value TEXT)']) db.prepare(statement).run();
    const sql = {exec: (query: string) => {
      const rows = db.prepare(query).all(); return {toArray: () => rows, one: () => rows[0]};
    }};
    const result = inspectStagedTables(sql, new Map(), new Map());
    expect(Object.keys(result.tables).sort()).toEqual(['cell_lines_xref-list', 'pub"refs']);
    expect(result.totalRows).toBe(3);
    expect(result.tables['cell_lines_xref-list']).toEqual({row_count: 2, columns: [{name: "accession", type: "TEXT", not_null: true, primary_key: false}]});
    expect(result.tables['pub"refs'].row_count).toBe(1);
    expect(result.tables['pub"refs'].columns[1].name).toBe("native-field");
  } finally { db.close(); }
});

it("emits executable relationship SQL for identifiers containing quotes and hyphens", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const statement of ['CREATE TABLE "cell""lines" (_rowid INTEGER PRIMARY KEY, name TEXT)', 'CREATE TABLE "cell""lines_xref-list" (parent_id INTEGER, accession TEXT)', 'INSERT INTO "cell""lines" VALUES (1, \'native\')', 'INSERT INTO "cell""lines_xref-list" VALUES (1, \'0002\')']) db.prepare(statement).run();
    const [relationship] = buildRelationshipJoins([{parent_table: 'cell"lines', child_table: 'cell"lines_xref-list', fk_column: "parent_id", source_column: "xref-list"}], undefined);
    expect(db.prepare(relationship.join_sql).all()).toEqual([{_rowid: 1, name: "native", parent_id: 1, accession: "0002"}]);
  } finally { db.close(); }
});
