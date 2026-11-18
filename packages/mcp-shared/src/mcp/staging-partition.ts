const PRIVATE_METHOD = "labhound/private-call-v1";
const PUBLIC_PARTITION = "public";
const privateBindings = new WeakSet<object>();

/** Only anonymous data belongs in a source's legacy public /datasets listing. */
export function isPrivateStagingBinding(binding: object): boolean {
	return privateBindings.has(binding);
}

export interface StagingPartitionOptions {
	/** Publisher-managed reference data with fixed names, populated outside MCP. */
	publishedDataReads?: (binding: string, name: string) => ReadonlySet<string> | undefined;
}

type NamedNamespace = Pick<DurableObjectNamespace, "get" | "idFromName">;

/** Translate logical names at the binding boundary, before native and Code Mode handlers see them. */
function partitionNamespace(raw: NamedNamespace, partition: string, publishedReads?: (name: string) => ReadonlySet<string> | undefined) {
	const issued = new Map<DurableObjectId, ReadonlySet<string> | undefined>();
	const idFromName = (name: string) => {
		if (typeof name !== "string") throw new TypeError("A dataset name is required");
		const reads = publishedReads?.(name);
		const objectName = reads ? name : JSON.stringify(["staging-v1", partition, name]);
		const id = raw.idFromName(objectName);
		issued.set(id, reads);
		return id;
	};
	const get = (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
		if (!issued.has(id)) throw new Error("Dataset ID outside this staging partition");
		const stub = raw.get(id, options);
		const reads = issued.get(id);
		if (!reads) return stub;
		// Never hand an MCP tool a writable stub for an operator's reference data.
		return {
			fetch(input: RequestInfo, init?: RequestInit) {
				const request = new Request(input, init);
				if (!reads.has(`${request.method} ${new URL(request.url).pathname}`)) {
					return Promise.resolve(new Response("Published reference data is read-only", {status: 403}));
				}
				return stub.fetch(request);
			},
		};
	};
	// Deliberately expose only named lookup. Raw object IDs skip name partitioning.
	const binding = { idFromName, get, getByName: (name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) => get(idFromName(name), options) };
	if (partition !== PUBLIC_PARTITION) privateBindings.add(binding);
	return binding;
}

export function publicStagingNamespace(raw: NamedNamespace) {
	return partitionNamespace(raw, PUBLIC_PARTITION);
}

function bindStaging(env: unknown, partition: string, options: StagingPartitionOptions): unknown {
	if (!env || typeof env !== "object") return env;
	const bindings: Record<string, unknown> = { ...env };
	for (const [name, value] of Object.entries(bindings)) {
		// The clinical queue uses a separate CLINICAL_STAGING_DATA_DO for MCP results.
		if (name === "CLINICAL_DATA_DO" || value == null) continue;
		if (name === "WORKSPACE_DO" || name === "JSON_TO_SQL_DO" || name.endsWith("_DATA_DO")) {
			bindings[name] = partitionNamespace(value as NamedNamespace, partition, (objectName) => options.publishedDataReads?.(name, objectName));
		}
	}
	return bindings;
}

type Dispatch = (request: Request, env: unknown) => Promise<Response>;

/** An older Worker cannot dispatch PRIVATE_METHOD as a tool call. */
export async function dispatchStagingRequest(request: Request, env: unknown, dispatch: Dispatch, options: StagingPartitionOptions = {}): Promise<Response> {
	if (request.headers.get("mcp-method") !== PRIVATE_METHOD) {
		return dispatch(request, bindStaging(env, PUBLIC_PARTITION, options));
	}
	if (env && typeof env === "object" && "CLINICAL_DATA_DO" in env) return new Response("Private staging unavailable", { status: 403 });
	const bearer = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
	if (!bearer || request.method !== "POST") return new Response("Invalid private staging request", { status: 403 });
	const body = await request.json().catch(() => null) as Record<string, unknown> | null;
	if (!body || body.jsonrpc !== "2.0" || body.method !== PRIVATE_METHOD || body.id == null) {
		return new Response("Invalid private staging envelope", { status: 400 });
	}
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer));
	const partition = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	const headers = new Headers(request.headers);
	headers.delete("authorization");
	headers.delete("content-length");
	headers.set("mcp-method", "tools/call");
	const inner = new Request(request.url, { method: "POST", headers, body: JSON.stringify({ ...body, method: "tools/call" }), signal: request.signal });
	const result = await dispatch(inner, bindStaging(env, partition, options));
	const response = new Response(result.body, result);
	response.headers.set("x-labhound-staging", "partition-v1");
	response.headers.set("cache-control", "private, no-store");
	return response;
}
