import { expect, it } from "vitest";
import { detectArrays, inferSchema } from "@bio-mcp/shared/staging/schema-inference";
import native from "./fixtures/research-2025.json";
import { openpaySchemaHints, openpayTables } from "./staging";

it("preserves all 252 native research columns across source-linked SQL groups", () => {
  const before = JSON.stringify(native);
  const tables = openpayTables({ native });
  const names = Object.keys(tables).filter(name => name.startsWith("research_payments"));
  expect(names).toHaveLength(4);
  for (const name of names) expect(tables[name]).toHaveLength(native.results.length);
  native.results.forEach((row, index) => {
    const joined = Object.assign({}, ...names.map(name => tables[name][index]));
    const { native_json: json, source_path: path, ...fields } = joined;
    expect(JSON.parse(json)).toEqual(row);
    expect(fields).toEqual(row);
    expect(path).toBe(`/native/results/${index}`);
    expect(Object.keys(row)).toHaveLength(252);
  });
  for (const name of names) expect(Object.keys(tables[name][0]).length).toBeLessThan(90);
  expect(JSON.parse(String(tables.response_context[0].native_json))).toEqual({ native });
  expect(JSON.stringify(native)).toBe(before);
  const hints = openpaySchemaHints({ native });
  expect(hints.columnTypes).toMatchObject({ principal_investigator_5_npi: "TEXT", covered_recipient_license_state_code2: "TEXT", total_amount_of_payment_usdollars: "TEXT" });
  expect(inferSchema(detectArrays(tables), hints).tables.map(table => table.name)).toEqual(expect.arrayContaining([...names, "response_context"]));
});

it("retains unknown columns, leading zeros, nulls, repeats and exact array positions", () => {
  const row = { record_id: "001", program_year: "2025", name_of_study: "", principal_investigator_2_npi: "0123456789", principal_investigator_5_npi: "0123456789", covered_recipient_specialty_2: "A|B", covered_recipient_specialty_3: "", future: { nested: [null, "", "0"] } };
  const tables = openpayTables({ content: [], structuredContent: { data: { results: [row, row] } } });
  expect(tables.research_payments.map(row => JSON.parse(String(row.native_json)))).toEqual([row, row]);
  expect(tables.research_payments[1]).toMatchObject({ source_path: "/results/1", future: JSON.stringify(row.future) });
});

it("keeps metadata and generic column groups visible alongside response context", () => {
  const meta = { identifier: "id", title: "Native dataset", distribution: [{ identifier: "dist" }] };
  expect(openpayTables({ candidates: [{ metadata: meta }] }).datasets[0].native_json).toBe(JSON.stringify(meta));
  const row = Object.fromEntries(Array.from({ length: 140 }, (_, index) => [`field_${index}`, `00${index}`]));
  const tables = openpayTables({ results: [row] });
  expect(inferSchema(detectArrays(tables), openpaySchemaHints(row)).tables.map(table => table.name)).toEqual(["results", "results_columns_2", "response_context"]);
});
