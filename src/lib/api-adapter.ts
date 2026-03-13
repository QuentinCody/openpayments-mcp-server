/**
 * OpenPayments API adapter — wraps openpaymentsFetch into the ApiFetchFn
 * interface for use by the Code Mode __api_proxy tool.
 */

import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { openpaymentsFetch } from "./http";

/**
 * Create an ApiFetchFn that routes through openpaymentsFetch.
 * No auth needed — OpenPayments DKAN API is public.
 */
export function createOpenPaymentsApiFetch(): ApiFetchFn {
    return async (request) => {
        const response = await openpaymentsFetch(request.path, request.params);

        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = response.statusText;
            }
            const error = new Error(
                `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
            ) as Error & {
                status: number;
                data: unknown;
            };
            error.status = response.status;
            error.data = errorBody;
            throw error;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
            const text = await response.text();
            return { status: response.status, data: text };
        }

        const data = await response.json();
        return { status: response.status, data };
    };
}
