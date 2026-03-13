/**
 * OpenPaymentsDataDO — Durable Object for staging large OpenPayments responses.
 *
 * Extends RestStagingDO with:
 * - Payment-specific schema hints
 * - Wide-table preprocessing: DKAN responses can have 160+ columns
 *   (numbered PI fields x5, product fields x5, specialty fields x6).
 *   We collapse these into pipe-delimited TEXT to stay under SQLite's column limit.
 */

import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

/**
 * Patterns for numbered repeat columns in DKAN payment data.
 * These appear as _1, _2, ... _N suffixes. We keep _1 as a regular column
 * and collapse _2+ into a pipe-delimited field named <base>_all.
 */
type RangeCollapsePattern = {
  base: string;
  start: number;
  end: number;
  sep?: string;
  prefix?: false;
};

type PrefixCollapsePattern = {
  base: string;
  prefix: true;
};

type CollapsePattern = RangeCollapsePattern | PrefixCollapsePattern;

const COLLAPSE_PATTERNS: CollapsePattern[] = [
  // General + Research: specialties 1-6
  { base: "covered_recipient_specialty", start: 2, end: 6 },
  { base: "covered_recipient_primary_type", start: 2, end: 6 },
  { base: "covered_recipient_license_state_code", start: 2, end: 5, sep: "" },
  // Products 1-5
  { base: "covered_or_noncovered_indicator", start: 2, end: 5, sep: "_" },
  {
    base: "indicate_drug_or_biological_or_device_or_medical_supply",
    start: 2,
    end: 5,
    sep: "_",
  },
  { base: "product_category_or_therapeutic_area", start: 2, end: 5, sep: "_" },
  {
    base: "name_of_drug_or_biological_or_device_or_medical_supply",
    start: 2,
    end: 5,
    sep: "_",
  },
  { base: "associated_drug_or_biological_ndc", start: 2, end: 5, sep: "_" },
  { base: "associated_device_or_medical_supply_pdi", start: 2, end: 5, sep: "_" },
  // Research: Principal Investigators 2-5 (each has ~15 sub-fields)
  { base: "principal_investigator_2", prefix: true },
  { base: "principal_investigator_3", prefix: true },
  { base: "principal_investigator_4", prefix: true },
  { base: "principal_investigator_5", prefix: true },
];

/**
 * Collapse numbered repeat columns in a DKAN row.
 * Returns a new object with fewer columns.
 */
function collapseWideRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const consumed = new Set<string>();

  for (const pattern of COLLAPSE_PATTERNS) {
    if (pattern.prefix === true) {
      // Collapse all keys starting with this prefix into a single JSON column.
      const prefix = pattern.base;
      const piValues: Record<string, unknown> = {};
      let hasValue = false;

      for (const key of Object.keys(row)) {
        if (key.startsWith(prefix)) {
          consumed.add(key);
          const val = row[key];
          if (val !== "" && val !== null && val !== undefined) {
            piValues[key] = val;
            hasValue = true;
          }
        }
      }

      if (hasValue) {
        result[`${prefix}_json`] = JSON.stringify(piValues);
      }
      continue;
    }

    // Collapse numbered suffix columns into pipe-delimited text.
    const sep = pattern.sep ?? "_";
    const values: string[] = [];

    for (let i = pattern.start; i <= pattern.end; i++) {
      const key = `${pattern.base}${sep}${i}`;
      consumed.add(key);
      const val = row[key];
      if (typeof val === "string" && val !== "") {
        values.push(val);
      }
    }

    if (values.length > 0) {
      result[`${pattern.base}_additional`] = values.join(" | ");
    }
  }

  // Copy all non-consumed keys.
  for (const [key, value] of Object.entries(row)) {
    if (!consumed.has(key)) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Preprocess DKAN datastore response: collapse wide rows in the results array.
 */
function preprocessDkanResponse(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.results) && obj.results.length > 0) {
    const sample = obj.results[0] as Record<string, unknown>;
    const columnCount = Object.keys(sample).length;

    // Only collapse if over 80 columns (general payments have ~76, research ~160)
    if (columnCount > 80) {
      obj.results = (obj.results as Record<string, unknown>[]).map(collapseWideRow);
    }
  }

  return obj;
}

export class OpenPaymentsDataDO extends RestStagingDO {
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // Intercept /process to preprocess wide DKAN tables
        if (url.pathname === "/process" && request.method === "POST") {
            const json = await request.json();
            const container = (json as Record<string, unknown>) || {};
            const data = (container as { data?: unknown }).data ?? json;

            const processed = preprocessDkanResponse(data);

            // Reconstruct the request body with preprocessed data
            const newBody = container.data !== undefined
                ? { ...container, data: processed }
                : processed;

            const newRequest = new Request(request.url, {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify(newBody),
            });

            return super.fetch(newRequest);
        }

        return super.fetch(request);
    }

    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

        const obj = data as Record<string, unknown>;

        // DKAN datastore query response: { results: [...], count: N, schema: {...} }
        if (Array.isArray(obj.results) && obj.results.length > 0) {
            const sample = obj.results[0] as Record<string, unknown>;

            // Research payments — check FIRST (also has total_amount_of_payment_usdollars)
            if ("name_of_study" in sample) {
                return {
                    tableName: "research_payments",
                    indexes: [
                        "covered_recipient_npi",
                        "covered_recipient_last_name",
                        "recipient_state",
                        "name_of_study",
                        "program_year",
                    ],
                };
            }

            // General payment data
            if ("total_amount_of_payment_usdollars" in sample) {
                return {
                    tableName: "payments",
                    indexes: [
                        "covered_recipient_npi",
                        "covered_recipient_last_name",
                        "recipient_state",
                        "applicable_manufacturer_or_applicable_gpo_making_payment_name",
                        "nature_of_payment_or_transfer_of_value",
                        "program_year",
                    ],
                };
            }

            // Ownership payment data
            if ("total_amount_invested_usdollars" in sample) {
                return {
                    tableName: "ownership_payments",
                    indexes: [
                        "physician_npi",
                        "physician_last_name",
                        "recipient_state",
                        "program_year",
                    ],
                };
            }

            // Generic DKAN results
            return {
                tableName: "data",
                indexes: ["record_id", "program_year"],
            };
        }

        // Array response (e.g. search results)
        if (Array.isArray(data) && data.length > 0) {
            const sample = data[0] as Record<string, unknown>;
            if ("identifier" in sample && "title" in sample) {
                return {
                    tableName: "datasets",
                    indexes: ["identifier", "title"],
                };
            }
        }

        return undefined;
    }
}
