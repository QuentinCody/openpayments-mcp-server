// interlinked-tdd: exempt -- source-module registry, no logic
import type { SourceModule } from "../types";
import { fdaOrangeBook } from "./fda-orange-book";
import { ensemblRelease } from "./ensembl-release";
import { gdcRelease } from "./gdc-release";
import { uniprotRelease } from "./uniprot-release";
import { gtexSchema } from "./gtex-schema";
import { eqtlR8Metadata } from "./eqtl-r8-metadata";

/** All monitorable sources, keyed by id. MonitorDO resolves a subscription's source_id here. */
export const SOURCES: Record<string, SourceModule> = {
	[fdaOrangeBook.id]: fdaOrangeBook,
	[ensemblRelease.id]: ensemblRelease,
	[gdcRelease.id]: gdcRelease,
	[uniprotRelease.id]: uniprotRelease,
	[gtexSchema.id]: gtexSchema,
	[eqtlR8Metadata.id]: eqtlR8Metadata,
};

export { fdaOrangeBook };
