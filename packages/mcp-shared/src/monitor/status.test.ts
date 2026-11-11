import { expect, it } from "vitest";
import { failedAttempt, MonitorCallError, monitoringStatus } from "./status";

it("reports stalled observation separately from provider publication age", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  expect(monitoringStatus(null, 60000, null, now)).toMatchObject({ freshness: "never_succeeded", provider_data_age: "unknown" });
  expect(monitoringStatus("2026-09-29T11:59:00Z", 60000, null, now).freshness).toBe("fresh");
  expect(monitoringStatus("2026-09-29T11:57:00Z", 60000, null, now).freshness).toBe("stale");
  expect(monitoringStatus("bad", 60000, null, now).freshness).toBe("unknown");
});
it("records explicit credential boundaries without retaining secret-bearing messages", () => {
  const attempt = failedAttempt(new MonitorCallError("credential_failure", "mcp_transport", 401, "private token"), "now");
  expect(attempt).toEqual({ checked_at: "now", outcome: "failure", failure_kind: "credential_failure", boundary: "mcp_transport", upstream_status: 401 });
  expect(JSON.stringify(attempt)).not.toContain("private");
  expect(failedAttempt(new Error("401 credential text is not evidence"), "now").failure_kind).toBe("check_failure");
});
