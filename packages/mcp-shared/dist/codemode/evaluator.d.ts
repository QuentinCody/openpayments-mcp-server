/**
 * V8 Isolate evaluator for Code Mode.
 *
 * Uses Worker Loader to spin up sandboxed V8 isolates that execute
 * agent-provided JavaScript code. The isolate gets a `codemode` Proxy
 * that routes function calls through CodeModeProxy (a WorkerEntrypoint
 * accessed via service binding) back to the agent's callTool() method.
 *
 * Flow: Isolate → CodeModeProxy (RPC) → DO.callTool() (RPC, reentrancy)
 *
 * The user's code is embedded directly in the module source (not eval'd),
 * since V8 isolates don't allow eval/new Function by default.
 */
export declare function createEvaluator(code: string, options: {
    loader: WorkerLoader;
    proxy: Fetcher;
    doId: string;
}): () => Promise<unknown>;
//# sourceMappingURL=evaluator.d.ts.map