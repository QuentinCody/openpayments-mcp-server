/**
 * OpenPaymentsDataDO — Durable Object for staging large OpenPayments responses.
 *
 * Extends RestStagingDO with payment-specific schema hints.
 */

import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export class OpenPaymentsDataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

        const obj = data as Record<string, unknown>;

        // DKAN datastore query response: { results: [...], count: N, schema: {...} }
        if (Array.isArray(obj.results) && obj.results.length > 0) {
            const sample = obj.results[0] as Record<string, unknown>;

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

            // Research payment data
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
