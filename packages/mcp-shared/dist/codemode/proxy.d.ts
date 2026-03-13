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
export declare class CodeModeProxy extends WorkerEntrypoint {
    private stubByDoId;
    callFunction(options: {
        functionName: string;
        args: unknown;
        doId: string;
    }): Promise<any>;
}
//# sourceMappingURL=proxy.d.ts.map