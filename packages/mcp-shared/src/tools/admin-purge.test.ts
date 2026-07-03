import { describe, expect, it, vi } from "vitest";
import {
	type AdminPurgeResult,
	adminPurgeMixin,
	handleAdminPurge,
} from "./admin-purge";

const OID = "a".repeat(64);
const TOKEN = "secret-token";

const makeStub = (
	over: Partial<Record<"__admin_purge__" | "__admin_stats__", unknown>> = {},
) => ({
	__admin_purge__: vi.fn(async () => ({
		purged: true,
		sqliteSizeBeforeBytes: 10,
		sqliteSizeAfterBytes: 0,
	})),
	__admin_stats__: vi.fn(async () => ({ sqliteSizeBytes: 10, tables: ["t"] })),
	...over,
});

const makeEnv = (stub = makeStub(), over: Record<string, unknown> = {}) => ({
	ADMIN_TOKEN: TOKEN,
	MCP_OBJECT: {
		idFromString: vi.fn((s: string) => ({ id: s })),
		get: vi.fn(() => stub),
	},
	...over,
});

const adminRequest = (
	op: "purge" | "stats",
	oid = OID,
	init: RequestInit = {},
) =>
	new Request(`https://worker.test/__admin__/${op}/${oid}`, {
		method: op === "purge" ? "DELETE" : "GET",
		headers: { "x-admin-token": TOKEN },
		...init,
	});

const call = (request: Request, env: Record<string, unknown>) =>
	handleAdminPurge(request, env, "MCP_OBJECT");

describe("handleAdminPurge routing & auth", () => {
	it("returns null for non-admin paths", async () => {
		expect(
			await call(new Request("https://worker.test/mcp"), makeEnv()),
		).toBeNull();
	});

	it("rejects object ids that are not 64 hex chars", async () => {
		const resp = await call(adminRequest("purge", "abc123"), makeEnv());
		expect(resp?.status).toBe(400);
		expect(await resp?.json()).toMatchObject({ error: "invalid object id" });
	});

	it("returns 503 when ADMIN_TOKEN is not configured", async () => {
		const resp = await call(
			adminRequest("purge"),
			makeEnv(makeStub(), { ADMIN_TOKEN: undefined }),
		);
		expect(resp?.status).toBe(503);
	});

	it("returns 403 on a token mismatch", async () => {
		const resp = await call(
			adminRequest("purge", OID, {
				method: "DELETE",
				headers: { "x-admin-token": "wrong" },
			}),
			makeEnv(),
		);
		expect(resp?.status).toBe(403);
	});

	it("returns 500 when the DO binding is missing", async () => {
		const resp = await call(
			adminRequest("purge"),
			makeEnv(makeStub(), { MCP_OBJECT: undefined }),
		);
		expect(resp?.status).toBe(500);
		expect(await resp?.json()).toMatchObject({ bindingName: "MCP_OBJECT" });
	});

	it("returns 400 when the id cannot be resolved", async () => {
		const env = makeEnv();
		(
			env.MCP_OBJECT as { idFromString: ReturnType<typeof vi.fn> }
		).idFromString.mockImplementation(() => {
			throw new Error("bad id");
		});
		const resp = await call(adminRequest("purge"), env);
		expect(resp?.status).toBe(400);
		expect(await resp?.json()).toMatchObject({
			error: "could not resolve id",
			message: "bad id",
		});
	});

	it("enforces DELETE for purge and GET for stats", async () => {
		const purgeViaGet = await call(
			adminRequest("purge", OID, { method: "GET" }),
			makeEnv(),
		);
		expect(purgeViaGet?.status).toBe(405);
		expect(await purgeViaGet?.json()).toMatchObject({ expected: "DELETE" });

		const statsViaDelete = await call(
			adminRequest("stats", OID, { method: "DELETE" }),
			makeEnv(),
		);
		expect(statsViaDelete?.status).toBe(405);
		expect(await statsViaDelete?.json()).toMatchObject({ expected: "GET" });
	});
});

describe("handleAdminPurge RPC dispatch", () => {
	it("dispatches purge to __admin_purge__ and returns its result", async () => {
		const stub = makeStub();
		const resp = await call(adminRequest("purge"), makeEnv(stub));
		expect(resp?.status).toBe(200);
		expect(await resp?.json()).toMatchObject({
			purged: true,
			sqliteSizeAfterBytes: 0,
		});
		expect(stub.__admin_purge__).toHaveBeenCalledTimes(1);
		expect(stub.__admin_stats__).not.toHaveBeenCalled();
	});

	it("dispatches stats to __admin_stats__", async () => {
		const stub = makeStub();
		const resp = await call(adminRequest("stats"), makeEnv(stub));
		expect(await resp?.json()).toMatchObject({ tables: ["t"] });
		expect(stub.__admin_stats__).toHaveBeenCalledTimes(1);
	});

	it("wraps RPC failures as a 500 with op context", async () => {
		const stub = makeStub({
			__admin_purge__: vi.fn(async () => {
				throw new Error("rpc exploded");
			}),
		});
		const resp = await call(adminRequest("purge"), makeEnv(stub));
		expect(resp?.status).toBe(500);
		expect(await resp?.json()).toMatchObject({
			error: "admin rpc failed",
			op: "purge",
			message: "rpc exploded",
		});
	});
});

describe("adminPurgeMixin", () => {
	it("purge reports sizes before and after deleteAll", async () => {
		let size = 4096;
		const storage = {
			deleteAll: vi.fn(async () => {
				size = 0;
			}),
			sql: {
				exec: () => ({ toArray: () => [] }),
				get databaseSize() {
					return size;
				},
			},
		};
		const result: AdminPurgeResult = await adminPurgeMixin.purge(storage);
		expect(result).toEqual({
			purged: true,
			sqliteSizeBeforeBytes: 4096,
			sqliteSizeAfterBytes: 0,
		});
		expect(storage.deleteAll).toHaveBeenCalledTimes(1);
	});

	it("purge reports null sizes when databaseSize is unavailable or throws", async () => {
		const noSize = {
			deleteAll: async () => {},
			sql: { exec: () => ({ toArray: () => [] }) },
		};
		expect(await adminPurgeMixin.purge(noSize)).toMatchObject({
			sqliteSizeBeforeBytes: null,
			sqliteSizeAfterBytes: null,
		});

		const throwing = {
			deleteAll: async () => {},
			sql: {
				exec: () => ({ toArray: () => [] }),
				get databaseSize(): number {
					throw new Error("detached");
				},
			},
		};
		expect(await adminPurgeMixin.purge(throwing)).toMatchObject({
			sqliteSizeBeforeBytes: null,
		});
	});

	it("stats lists tables and tolerates SQL failures", () => {
		const storage = {
			deleteAll: async () => {},
			sql: {
				exec: () => ({ toArray: () => [{ name: "alpha" }, { name: "beta" }] }),
				databaseSize: 123,
			},
		};
		expect(adminPurgeMixin.stats(storage)).toEqual({
			sqliteSizeBytes: 123,
			tables: ["alpha", "beta"],
		});

		const broken = {
			deleteAll: async () => {},
			sql: {
				exec: () => {
					throw new Error("no sql");
				},
				databaseSize: 5,
			},
		};
		expect(adminPurgeMixin.stats(broken)).toEqual({
			sqliteSizeBytes: 5,
			tables: [],
		});
	});
});
