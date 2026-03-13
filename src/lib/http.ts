/**
 * OpenPayments DKAN API HTTP client.
 *
 * Wraps the CMS Open Payments DKAN datastore API with retry/backoff handling.
 * Base URL: https://openpaymentsdata.cms.gov/api/1
 */

import { restFetch, type RestFetchOptions } from "@bio-mcp/shared/http/rest-fetch";

const OPENPAYMENTS_BASE = "https://openpaymentsdata.cms.gov/api/1";

export interface OpenPaymentsFetchOptions extends Omit<RestFetchOptions, "retryOn"> {
    headers?: Record<string, string>;
}

/**
 * Expand DKAN-style indexed array params.
 *
 * Converts: { conditions: [{ property: "name", value: "Smith", operator: "=" }] }
 * Into:     { "conditions[0][property]": "name", "conditions[0][value]": "Smith", "conditions[0][operator]": "=" }
 */
export function expandDkanParams(
    params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
    if (!params) return params;

    const expanded: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
            // Expand array of objects into indexed bracket notation
            for (let i = 0; i < value.length; i++) {
                const item = value[i] as Record<string, unknown>;
                for (const [subKey, subVal] of Object.entries(item)) {
                    expanded[`${key}[${i}][${subKey}]`] = subVal;
                }
            }
        } else {
            expanded[key] = value;
        }
    }

    return expanded;
}

/**
 * Fetch from the OpenPayments DKAN API with retry handling.
 */
export async function openpaymentsFetch(
    path: string,
    params?: Record<string, unknown>,
    opts?: OpenPaymentsFetchOptions,
): Promise<Response> {
    const headers: Record<string, string> = {
        Accept: "application/json",
        ...(opts?.headers ?? {}),
    };

    const expandedParams = expandDkanParams(params);

    return restFetch(OPENPAYMENTS_BASE, path, expandedParams, {
        ...opts,
        headers,
        retryOn: [429, 500, 502, 503],
        retries: opts?.retries ?? 3,
        timeout: opts?.timeout ?? 30_000,
        userAgent:
            "openpayments-mcp-server/1.0 (bio-mcp; https://github.com/QuentinCody/openpayments-mcp-server)",
    });
}

/**
 * Known dataset IDs for the OpenPayments DKAN datastore.
 * Maps (type, year) → dataset UUID.
 */
export const DATASET_IDS: Record<string, Record<number, string>> = {
    general: {
        2024: "e6b17c6a-2534-4207-a4a1-6746a14911ff",
        2023: "fb3a65aa-c901-4a38-a813-b04b00dfa2a9",
        2022: "df01c2f8-dc1f-4e79-96cb-8208beaf143c",
        2021: "0380bbeb-aea1-58b6-b708-829f92a48202",
        2020: "a08c4b30-5cf3-4948-ad40-36f404619019",
        2019: "4e54dd6c-30f8-4f86-86a7-3c109a89528e",
        2018: "f003634c-c103-568f-876c-73017fa83be0",
    },
    research: {
        2024: "2f15cb85-8887-4dcc-a318-1f8ec1d815b3",
        2023: "ec9521bf-9d97-4603-814c-f4132d34bc4f",
        2022: "fdc3c773-018a-412c-8a81-d7b8a13a037b",
        2021: "ce1d28dd-0094-5060-a036-580329439600",
        2020: "9c248e7e-7c7f-478b-ab84-ce0919d72c1c",
        2019: "713a6016-1930-4a0c-b7c2-3e3de4f244c5",
        2018: "7b82fb48-2bec-45f0-b40e-aed5f1d1eba0",
    },
    ownership: {
        2024: "9ac4f7f8-b6e4-4d80-8410-4aba7e71dd02",
        2022: "37792388-800f-427a-9e02-b11601454eeb",
        2019: "0b5c9710-7edb-484e-abc8-39293849ccb2",
    },
};

/**
 * Covered Recipient Profile Supplement (all years)
 */
export const PROFILE_SUPPLEMENT_ID = "23160558-6742-54ff-8b9f-cac7d514ff4e";
