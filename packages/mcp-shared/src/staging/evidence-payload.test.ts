import { describe, expect, it, vi } from "vitest";
import { storeEvidencePayload } from "./evidence-payload";

describe("storeEvidencePayload", () => {
	it("stores the complete serialized payload with a SHA-256 integrity anchor", async () => {
		const calls: Array<{ query: string; bindings: unknown[] }> = [];
		const sql = {
			exec(query: string, ...bindings: unknown[]) {
				calls.push({ query, bindings });
				return { toArray: () => [] };
			},
		};
		const smartJsonStringify = vi.fn(async (data: unknown) => JSON.stringify(data));
		const payload = { rows: [{ id: 1 }, { id: 2 }], note: "complete" };
		const handle = await storeEvidencePayload(
			sql,
			{ smartJsonStringify },
			payload,
		);
		expect(handle.tableName).toBe("evidence_payloads");
		expect(handle.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(smartJsonStringify).toHaveBeenCalledWith(payload, sql);
		const insert = calls.find((call) => call.query.startsWith("INSERT OR REPLACE"));
		expect(insert?.bindings[0]).toBe(JSON.stringify(payload));
		expect(insert?.bindings[1]).toBe(handle.payloadHash);
		expect(insert?.bindings[2]).toBe(handle.payloadBytes);
	});
});

