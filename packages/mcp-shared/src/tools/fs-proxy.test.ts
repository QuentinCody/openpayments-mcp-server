/**
 * Tests for fs-proxy host handlers — validates handler creation and DO routing.
 */

import { describe, it, expect, vi } from "vitest";
import { createFsProxyHandlers } from "./fs-proxy";

function createMockDoNamespace(responseData: unknown = { success: true, data: "ok" }) {
	const fetchFn = vi.fn().mockResolvedValue({
		json: () => Promise.resolve(responseData),
	});

	return {
		namespace: {
			idFromName: vi.fn().mockReturnValue("mock-id"),
			get: vi.fn().mockReturnValue({ fetch: fetchFn }),
		},
		fetchFn,
	};
}

describe("createFsProxyHandlers", () => {
	it("returns all 9 handler functions", () => {
		const { namespace } = createMockDoNamespace();
		const handlers = createFsProxyHandlers({ doNamespace: namespace });

		const expectedKeys = [
			"__fs_read",
			"__fs_write",
			"__fs_append",
			"__fs_mkdir",
			"__fs_readdir",
			"__fs_stat",
			"__fs_exists",
			"__fs_rm",
			"__fs_glob",
		];

		for (const key of expectedKeys) {
			expect(handlers[key]).toBeDefined();
			expect(typeof handlers[key]).toBe("function");
		}

		expect(Object.keys(handlers)).toHaveLength(9);
	});

	it("routes __fs_read to DO /fs/read endpoint", async () => {
		const { namespace, fetchFn } = createMockDoNamespace({
			success: true,
			data: "file content here",
		});
		const handlers = createFsProxyHandlers({ doNamespace: namespace });

		const result = await handlers.__fs_read({ path: "/test.txt" });

		expect(result).toBe("file content here");
		expect(namespace.idFromName).toHaveBeenCalledWith("__fs__");
		expect(fetchFn).toHaveBeenCalledTimes(1);

		const request = fetchFn.mock.calls[0][0] as Request;
		expect(request.url).toBe("http://localhost/fs/read");
		expect(request.method).toBe("POST");

		const body = await request.json();
		expect(body).toEqual({ path: "/test.txt" });
	});

	it("routes __fs_write with content", async () => {
		const { namespace, fetchFn } = createMockDoNamespace({
			success: true,
			data: { path: "/out.json", size: 42 },
		});
		const handlers = createFsProxyHandlers({ doNamespace: namespace });

		const result = await handlers.__fs_write({ path: "/out.json", content: '{"key":"val"}' });

		expect(result).toEqual({ path: "/out.json", size: 42 });

		const request = fetchFn.mock.calls[0][0] as Request;
		expect(request.url).toBe("http://localhost/fs/write");
	});

	it("returns __fs_error on DO failure", async () => {
		const { namespace } = createMockDoNamespace({
			success: false,
			error: "File not found: /missing.txt",
		});
		const handlers = createFsProxyHandlers({ doNamespace: namespace });

		const result = await handlers.__fs_read({ path: "/missing.txt" });

		expect(result).toEqual({
			__fs_error: true,
			message: "File not found: /missing.txt",
		});
	});

	it("handles non-object args gracefully", async () => {
		const { namespace, fetchFn } = createMockDoNamespace({ success: true, data: true });
		const handlers = createFsProxyHandlers({ doNamespace: namespace });

		await handlers.__fs_exists(null);

		const request = fetchFn.mock.calls[0][0] as Request;
		const body = await request.json();
		expect(body).toEqual({});
	});
});
