// interlinked-tdd: exempt -- source-module registry, no logic
import type { SourceModule } from "../types";
import { fdaOrangeBook } from "./fda-orange-book";

/** All monitorable sources, keyed by id. MonitorDO resolves a subscription's source_id here. */
export const SOURCES: Record<string, SourceModule> = {
	[fdaOrangeBook.id]: fdaOrangeBook,
};

export { fdaOrangeBook };
