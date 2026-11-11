import type { SourceModule } from "../types";

export const ensemblRelease: SourceModule = {
  id: "ensembl-release",
  label: "Ensembl REST — available data releases",
  profile: { stripKeys: ["_meta", "success"], tables: [{ table: "release", path: "data.release", keyFields: ["source"], valueFields: ["releases"] }] },
  buildQuery: () => ({ server: "ensembl", tool: "ensembl_execute", params: { code: [
    'const native = await api.get("/info/data");',
    'if (!Array.isArray(native.releases) || !native.releases.length || native.releases.some(x => !Number.isInteger(x) || x <= 0)) throw new Error("Invalid or staged Ensembl release response");',
    'return {release:[{source:"ensembl-rest", releases:[...native.releases].sort((a,b) => a-b), native}]};',
  ].join("\n") } }),
  classify: () => ({ materiality: "info", label: "Ensembl available data releases changed; requalify release-dependent analyses" }),
};
