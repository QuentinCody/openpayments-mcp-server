/**
 * CodeModeProxy — bridge between V8 isolates and Durable Object tools.
 *
 * This WorkerEntrypoint receives callFunction() from V8 isolates and
 * routes them to the agent's callTool() method via DO RPC.
 *
 * Needed because DurableObjectStub/DurableObjectNamespace can't be
 * serialized across Worker Loader isolate boundaries, but a Fetcher
 * to a WorkerEntrypoint (via service binding) CAN be.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

/** Environment shape expected by CodeModeProxy — each server binds MCP_OBJECT. */
interface CodeModeProxyEnv {
	MCP_OBJECT: DurableObjectNamespace;
}

/** Durable Object stub with the callTool RPC method exposed by McpAgent subclasses. */
interface McpAgentStub extends DurableObjectStub {
	callTool(name: string, args: unknown[]): Promise<unknown>;
}

export class CodeModeProxy extends WorkerEntrypoint<CodeModeProxyEnv> {
	private stubByDoId = new Map<string, McpAgentStub>();

	async callFunction(options: { functionName: string; args: unknown; doId: string }) {
		let stub = this.stubByDoId.get(options.doId);
		if (!stub) {
			const ns = this.env.MCP_OBJECT;
			const id = ns.idFromString(options.doId);
			stub = ns.get(id) as McpAgentStub;
			this.stubByDoId.set(options.doId, stub);
		}
		return stub.callTool(options.functionName, [options.args]);
	}
}
