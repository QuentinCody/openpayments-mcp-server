import { BUILD_GIT_SHA, FLEET_CONTRACT_VERSION } from "./constants";

export interface FleetHealth {
	status: "ok";
	server: string;
	git_sha: string;
	fleet_contract_version: string;
}

export function buildHealthPayload(
	server: string,
	extra: Record<string, unknown> = {},
): FleetHealth & Record<string, unknown> {
	return {
		...extra,
		status: "ok",
		server,
		git_sha: BUILD_GIT_SHA,
		fleet_contract_version: FLEET_CONTRACT_VERSION,
	};
}

export function buildHealthResponse(
	server: string,
	extra: Record<string, unknown> = {},
): Response {
	return Response.json(buildHealthPayload(server, extra), {
		headers: { "cache-control": "no-store" },
	});
}
