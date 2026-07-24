import { describe, expect, it, vi } from "vitest";
import { preservePayloadInDo } from "./lossless-stage";

describe("preservePayloadInDo", () => {
	it("writes canonical full evidence before relational materialization", async () => {
		const requests: Request[] = [];
		const fetch = vi.fn(async (request: Request) => {
			requests.push(request);
			return new Response(JSON.stringify({ success: true }), {
				headers: { "content-type": "application/json" },
			});
		});
		const payload = { z: 1, rows: [{ id: 2 }, { id: 3 }] };
		const result = await preservePayloadInDo(payload, { fetch }, {
			toolName: "demo_search",
		});
		const body = (await requests[0].clone().json()) as {
			data: string;
			context: { toolName: string };
		};
		expect(JSON.parse(body.data)).toEqual(payload);
		expect(body.context.toolName).toBe("demo_search__lossless_evidence");
		expect(result.evidenceTable).toBe("payloads");
		expect(result.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("fails before materialization when complete evidence cannot be stored", async () => {
		const fetch = vi.fn(async () =>
			new Response(JSON.stringify({ success: false, error: "full" })),
		);
		await expect(preservePayloadInDo({ rows: [1] }, { fetch })).rejects.toThrow(
			/complete source payload: full/,
		);
	});
});
