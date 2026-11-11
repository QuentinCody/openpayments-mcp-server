import type { SourceModule } from "../types";

const PROBE_URL = "https://rest.uniprot.org/uniprotkb/search?query=accession%3AP69905&fields=accession&format=json&size=1";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Observe one current UniProtKB response, without treating an entry revision as a release. */
function prepareResult(result: unknown) {
  const envelope = object(result);
  const native = object(envelope?.data);
  const context = object(native?._uniprot);
  const entries = native?.results;
  const date = context?.release_date;
  if (envelope?.success !== true || envelope.isError || envelope.staged || envelope._staging ||
      !native || native.__staged || native.error || native.errors ||
      !Array.isArray(entries) || entries.length !== 1 || object(entries[0])?.primaryAccession !== "P69905" ||
      context?.source_url !== PROBE_URL || typeof context.release !== "string" || context.release.length !== 7 || !/^\d{4}_\d{2}$/.test(context.release) ||
      (date != null && (typeof date !== "string" || !date.trim() || date.length > 128))) {
    throw new Error("monitor: incomplete, failed or unrecognized UniProt release response; retaining the prior snapshot");
  }
  return {
    releases: [{ component: "uniprotkb", version: { release: context.release, release_date: date ?? null } }],
    evidence: result,
  };
}

export const uniprotRelease: SourceModule = {
  id: "uniprot-release",
  label: "UniProtKB — observed data release",
  profile: { tables: [{ table: "release", path: "releases", keyFields: ["component"], valueFields: ["version"] }] },
  buildQuery: () => ({ server: "uniprot", tool: "uniprot_api_execute", params: {
    code: 'return await api.get("/uniprotkb/search", {query:"accession:P69905", fields:"accession", format:"json", size:1});',
  } }),
  prepareResult,
  classify: () => ({ materiality: "info", label: "UniProtKB observed release metadata changed; requalify release-dependent analyses (not an archived release pin)" }),
};
