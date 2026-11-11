import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import { openpaySchemaHints, openpayTables } from "./lib/staging";

export class OpenPaymentsDataDO extends RestStagingDO {
  protected getTabularData(value: unknown): unknown {
    return value === null || typeof value !== "object" ? value : openpayTables(value);
  }
  protected getSchemaHints(value: unknown) {
    return openpaySchemaHints(value);
  }
}
