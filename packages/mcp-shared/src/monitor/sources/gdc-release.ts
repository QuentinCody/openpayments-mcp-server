import type { SourceModule } from "../types";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only a complete, successful status response can replace the last good snapshot. */
function prepareResult(result: unknown) {
  const envelope = object(result);
  const native = object(envelope?.data);
  const context = object(envelope?._rest);
  if (!envelope || envelope.success !== true || envelope.staged || envelope._staging ||
      !native || native.__staged || native.error || native.errors || native.status !== "OK" ||
      typeof native.tag !== "string" || !native.tag.trim() ||
      !((typeof native.version === "number" && Number.isFinite(native.version)) ||
        (typeof native.version === "string" && native.version.trim())) ||
      context?.operation !== "status" || context.http_status !== 200 ||
      context.source_url !== "https://api.gdc.cancer.gov/status") {
    throw new Error("monitor: incomplete, failed or unrecognized GDC status response; retaining the prior snapshot");
  }
  return {
    releases: [
      { component: "api", version: { tag: native.tag, version: native.version, commit: native.commit ?? null } },
      { component: "data", version: {
        data_release: native.data_release ?? null,
        data_release_version: native.data_release_version ?? null,
        data_release_header: context.data_release_header ?? null,
      } },
    ],
    // Preserve complete provider fields, citation and request context, but compare only release fields.
    evidence: result,
  };
}

export const gdcRelease: SourceModule = {
  id: "gdc-release",
  label: "GDC — API build and reported data release",
  profile: { tables: [{ table: "release", path: "releases", keyFields: ["component"], valueFields: ["version"] }] },
  buildQuery: () => ({ server: "nci-gdc", tool: "gdc_rest", params: { operation: "status", parameters: {} } }),
  prepareResult,
  classify: (change) => ({ materiality: "info", label: change.keyValues.component === "api"
    ? "GDC API version/build changed; revalidate API contracts"
    : "GDC reported data-release metadata changed; requalify release-dependent analyses (not a historical pin)" }),
};
