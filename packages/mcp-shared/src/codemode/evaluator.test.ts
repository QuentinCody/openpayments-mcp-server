import { describe, expect, it, vi } from "vitest";
import { createEvaluator } from "./evaluator";

describe("createEvaluator", () => {
	it("assembles the isolate module source and runs it via the worker loader", async () => {
		let capturedConfig: { mainModule: string; modules: Record<string, string>; env: Record<string, unknown>; compatibilityFlags: string[] } | undefined;
		const entrypoint = { evaluate: vi.fn(async () => ({ ok: 1 })) };
		const loader = {
			get: vi.fn((_name: string, factory: () => typeof capturedConfig) => {
				capturedConfig = factory();
				return { getEntrypoint: () => entrypoint };
			}),
		};
		const proxy = { fetch: vi.fn() };

		const run = createEvaluator("return 42;", { loader: loader as never, proxy: proxy as never, doId: "do-xyz" });
		expect(typeof run).toBe("function");

		const result = await run();
		expect(result).toEqual({ ok: 1 });
		expect(loader.get).toHaveBeenCalledTimes(1);
		expect(entrypoint.evaluate).toHaveBeenCalledTimes(1);

		// The factory's worker config embeds the user code, the DO id, and the proxy binding.
		expect(capturedConfig?.mainModule).toBe("evaluator.js");
		expect(capturedConfig?.modules["evaluator.js"]).toContain("return 42;");
		expect(capturedConfig?.modules["evaluator.js"]).toContain("do-xyz");
		expect(capturedConfig?.env.CODE_MODE_PROXY).toBe(proxy);
		expect(capturedConfig?.compatibilityFlags).toContain("nodejs_compat");
	});
});
