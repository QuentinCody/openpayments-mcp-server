import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./registry";
import type { ToolContext, ToolEntry } from "./types";

const CTX = {} as ToolContext;

const entry = (over: Partial<ToolEntry> & { name: string }): ToolEntry =>
	({
		description: `desc for ${over.name}`,
		schema: { q: z.string() },
		handler: async () => ({ ok: true }),
		...over,
	}) as ToolEntry;

// Minimal McpServer.tool capture.
const makeServer = () => {
	const registered: Array<{
		name: string;
		handler: (input: unknown) => Promise<unknown>;
	}> = [];
	const server = {
		tool: (
			name: string,
			_desc: unknown,
			_schema: unknown,
			handler: (input: unknown) => Promise<unknown>,
		) => {
			registered.push({ name, handler });
		},
	};
	return { server: server as never, registered };
};

describe("ToolRegistry.add / lookup", () => {
	it("stores entries and indexes them by name", async () => {
		const reg = new ToolRegistry(CTX);
		const handler = vi.fn(async () => ({ value: 1 }));
		reg.add(entry({ name: "alpha", handler }));
		expect(await reg.handleIsolateCall("alpha", [{ a: 1 }])).toEqual({
			value: 1,
		});
		expect(handler).toHaveBeenCalledWith({ a: 1 }, CTX);
	});
});

describe("ToolRegistry.registerAll", () => {
	it("registers non-hidden tools and wraps successful results as MCP text content", async () => {
		const reg = new ToolRegistry(CTX);
		reg.add(entry({ name: "visible", handler: async () => ({ n: 5 }) }));
		reg.add(entry({ name: "secret", hidden: true }));
		const { server, registered } = makeServer();
		reg.registerAll(server);

		expect(registered.map((r) => r.name)).toEqual(["visible"]); // hidden skipped
		expect(await registered[0].handler({})).toEqual({
			content: [{ type: "text", text: JSON.stringify({ n: 5 }) }],
		});
	});

	it("serializes undefined results as the string 'undefined'", async () => {
		const reg = new ToolRegistry(CTX);
		reg.add(entry({ name: "v", handler: async () => undefined }));
		const { server, registered } = makeServer();
		reg.registerAll(server);
		expect(await registered[0].handler({})).toEqual({
			content: [{ type: "text", text: "undefined" }],
		});
	});

	it("wraps handler errors as an isError response", async () => {
		const reg = new ToolRegistry(CTX);
		reg.add(
			entry({
				name: "boom",
				handler: async () => {
					throw new Error("nope");
				},
			}),
		);
		const { server, registered } = makeServer();
		reg.registerAll(server);
		expect(await registered[0].handler({})).toEqual({
			isError: true,
			content: [{ type: "text", text: JSON.stringify({ error: "nope" }) }],
		});
	});

	it("stringifies non-Error throws", async () => {
		const reg = new ToolRegistry(CTX);
		reg.add(
			entry({
				name: "boom",
				handler: async () => {
					throw "raw failure";
				},
			}),
		);
		const { server, registered } = makeServer();
		reg.registerAll(server);
		expect(await registered[0].handler({})).toMatchObject({
			isError: true,
			content: [
				{ type: "text", text: JSON.stringify({ error: "raw failure" }) },
			],
		});
	});
});

describe("ToolRegistry.handleIsolateCall", () => {
	it("returns an error object for an unknown tool", async () => {
		const reg = new ToolRegistry(CTX);
		expect(await reg.handleIsolateCall("ghost", [])).toEqual({
			error: "Unknown tool: ghost",
		});
	});

	it("defaults missing args to an empty object", async () => {
		const reg = new ToolRegistry(CTX);
		const handler = vi.fn(async () => "ok");
		reg.add(entry({ name: "t", handler }));
		await reg.handleIsolateCall("t", []);
		expect(handler).toHaveBeenCalledWith({}, CTX);
	});
});

describe("ToolRegistry.buildExecutorFns", () => {
	it("builds callable fns for ALL tools including hidden ones", async () => {
		const reg = new ToolRegistry(CTX);
		reg.add(entry({ name: "visible", handler: async (i) => i }));
		reg.add(entry({ name: "secret", hidden: true, handler: async () => "h" }));
		const altCtx = {} as ToolContext;
		const fns = reg.buildExecutorFns(altCtx);
		expect(Object.keys(fns).sort()).toEqual(["secret", "visible"]);
		expect(await fns.visible({ x: 1 })).toEqual({ x: 1 });
		expect(await fns.secret(undefined)).toBe("h"); // null/undefined args default to {}
	});
});

describe("ToolRegistry type generation", () => {
	it("toToolDescriptors wraps schemas in z.object and excludes hidden tools", () => {
		const reg = new ToolRegistry(CTX);
		reg.add(entry({ name: "visible" }));
		reg.add(entry({ name: "secret", hidden: true }));
		const descriptors = reg.toToolDescriptors();
		expect(Object.keys(descriptors)).toEqual(["visible"]);
		expect(descriptors.visible.inputSchema).toBeInstanceOf(z.ZodObject);
		expect(descriptors.visible.inputSchema.safeParse({ q: "hi" }).success).toBe(
			true,
		);
	});

	it("getDefinitions returns non-hidden name/description/inputSchema triples", () => {
		const reg = new ToolRegistry(CTX);
		reg.add(entry({ name: "visible" }));
		reg.add(entry({ name: "secret", hidden: true }));
		const defs = reg.getDefinitions();
		expect(defs).toHaveLength(1);
		expect(defs[0]).toMatchObject({
			name: "visible",
			description: "desc for visible",
		});
		expect(defs[0].inputSchema).toBe(reg.getDefinitions()[0].inputSchema);
	});
});
