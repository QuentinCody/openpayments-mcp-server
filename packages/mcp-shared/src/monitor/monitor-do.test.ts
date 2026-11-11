import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../provenance/provenance";
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { MonitorDO } from "./monitor-do";

function fixture(binding = "SRV_FDA_ORANGE_BOOK") {
  const database = new DatabaseSync(":memory:");
  const alarm = vi.fn();
  const service = { fetch: vi.fn(async () => Response.json({ result: { structuredContent: { success: true, data: { exclusivity: [], patents: [] } } } })) };
  const ctx = { storage: { setAlarm: alarm, sql: { exec: (sql: string, ...values: any[]) => ({ toArray: () => database.prepare(sql).all(...values) }) } }, blockConcurrencyWhile: (run: () => Promise<void>) => run() };
  // SAFETY: fixture supplies the SQLite, alarm, and binding methods used by MonitorDO.
  const monitor = new MonitorDO(ctx as unknown as DurableObjectState, { [binding]: service } as unknown as ConstructorParameters<typeof MonitorDO>[1]);
  const call = (path: string, body?: unknown) => monitor.fetch(new Request(`https://fixture${path}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined }));
  return { database, alarm, service, call };
}
const subscription = { id: "fda-orange-book:123", source_id: "fda-orange-book", input: { nda: "123" }, cadence_ms: 60000 };

it("persists GTEx definition diffs, exposes optional native details and retains the prior snapshot on invalid schema", async () => {
  const f = fixture("SRV_GTEX");
  const sub = { ...subscription, id: "gtex-schema:current", source_id: "gtex-schema", input: {} };
  const response = async (description: string) => {
    const document = { openapi: "3.1.0", info: { title: "GTEx Portal API", version: "2.0.0" }, paths: { "/api/v2/": { get: { description } } } };
    return Response.json({ result: { structuredContent: { success: true, data: { document, _schema: {
      source_url: "https://gtexportal.org/api/v2/openapi.json", http_status: 200, retrieved_at: new Date().toISOString(), parsed_response_sha256: await sha256Hex(canonicalJson(document)),
    } } } } });
  };
  try {
    f.service.fetch.mockResolvedValueOnce(await response("before"));
    expect((await f.call("/create", sub)).status).toBe(200);
    f.service.fetch.mockResolvedValueOnce(await response("after"));
    expect(await (await f.call("/check_now", { id: sub.id })).json()).toMatchObject({ ok: true, changes: 1 });
    const summary = await (await f.call(`/changes?id=${sub.id}`)).json() as { changes: Array<Record<string, unknown>> };
    expect(summary.changes[0].detail).toBeUndefined();
    const detail = await (await f.call(`/changes?id=${sub.id}&include_details=true`)).json();
    expect(detail).toMatchObject({ changes: [{ detail: { before: { value: { native: { get: { description: "before" } } } }, after: { value: { native: { get: { description: "after" } } } } } }], provenance: { intact: true } });
    f.service.fetch.mockResolvedValueOnce(Response.json({ result: { structuredContent: { success: true, data: { document: {} } } } }));
    expect((await f.call("/check_now", { id: sub.id })).status).toBe(500);
    expect(databaseCount(f.database)).toBe(2);
    expect(f.alarm).toHaveBeenCalledTimes(1);
  } finally { f.database.close(); }
});

it("persists UniProt release changes through the existing binding and retains the baseline on missing headers", async () => {
  const f = fixture("SRV_UNIPROT");
  const sub = { ...subscription, id: "uniprot-release:current", source_id: "uniprot-release", input: {} };
  const response = (release: string | null) => Response.json({ result: { structuredContent: {
    success: true, data: { results: [{ primaryAccession: "P69905" }], _uniprot: {
      source_url: "https://rest.uniprot.org/uniprotkb/search?query=accession%3AP69905&fields=accession&format=json&size=1",
      release, release_date: null,
    } },
  } } });
  try {
    f.service.fetch.mockResolvedValueOnce(response("2026_01"));
    expect((await f.call("/create", sub)).status).toBe(200);
    expect(f.service.fetch).toHaveBeenCalledWith("https://mcp.internal/mcp", expect.objectContaining({ body: expect.stringContaining('"name":"uniprot_api_execute"') }));
    f.service.fetch.mockResolvedValueOnce(response("2026_02"));
    expect(await (await f.call("/check_now", { id: sub.id })).json()).toMatchObject({ ok: true, changes: 1 });
    expect(f.database.prepare("SELECT key, kind FROM monitor_change").all()).toEqual([{ key: "uniprotkb", kind: "changed" }]);
    f.service.fetch.mockResolvedValueOnce(response(null));
    expect((await f.call("/check_now", { id: sub.id })).status).toBe(500);
    expect(databaseCount(f.database)).toBe(2);
    expect(await (await f.call(`/changes?id=${sub.id}`)).json()).toMatchObject({ provenance: { intact: true } });
    expect(f.alarm).toHaveBeenCalledTimes(1);
  } finally { f.database.close(); }
});

it("routes GDC through its binding, persists release diffs and keeps the last good snapshot on failure", async () => {
  const f = fixture("SRV_NCI_GDC");
  const sub = { ...subscription, id: "gdc-release:current", source_id: "gdc-release", input: {} };
  const response = (tag: string) => Response.json({ result: { structuredContent: {
    success: true, data: { status: "OK", tag, version: 1, data_release: "release-a" },
    _rest: { operation: "status", http_status: 200, source_url: "https://api.gdc.cancer.gov/status" },
  } } });
  try {
    f.service.fetch.mockResolvedValueOnce(response("8.5.0"));
    expect((await f.call("/create", sub)).status).toBe(200);
    f.service.fetch.mockResolvedValueOnce(response("8.6.0"));
    expect(await (await f.call("/check_now", { id: sub.id })).json()).toMatchObject({ ok: true, changes: 1 });
    expect(f.database.prepare("SELECT key, kind FROM monitor_change").all()).toEqual([{ key: "api", kind: "changed" }]);
    f.service.fetch.mockResolvedValueOnce(Response.json({ result: { structuredContent: { success: true, staged: true } } }));
    expect((await f.call("/check_now", { id: sub.id })).status).toBe(500);
    expect(databaseCount(f.database)).toBe(2);
    expect(await (await f.call(`/changes?id=${sub.id}`)).json()).toMatchObject({ provenance: { intact: true } });
    expect(f.alarm).toHaveBeenCalledTimes(1);
  } finally { f.database.close(); }
});

it("preserves the last successful snapshot through auth failure and recovers", async () => {
  const f = fixture();
  try {
    expect((await f.call("/create", subscription)).status).toBe(200);
    const before = z.object({ last_success_at: z.string() }).parse(await (await f.call(`/status?id=${subscription.id}`)).json());
    f.service.fetch.mockResolvedValueOnce(new Response("private auth details", { status: 401 }));
    expect((await f.call("/check_now", { id: subscription.id })).status).toBe(500);
    const after = await (await f.call(`/status?id=${subscription.id}`)).json();
    expect(after).toMatchObject({ last_success_at: before.last_success_at, last_attempt: { outcome: "failure", failure_kind: "credential_failure", boundary: "mcp_transport", upstream_status: 401 } });
    expect(JSON.stringify(after)).not.toContain("private auth details");
    expect(databaseCount(f.database)).toBe(1);
    expect(await (await f.call("/check_now", { id: subscription.id })).json()).toMatchObject({ ok: true, unchanged: true });
    expect(await (await f.call(`/status?id=${subscription.id}`)).json()).toMatchObject({ last_attempt: { outcome: "success" } });
    expect(await (await f.call(`/changes?id=${subscription.id}`)).json()).toMatchObject({ snapshots: 1, provenance: { intact: true } });
    expect(f.alarm).toHaveBeenCalledTimes(1);
  } finally { f.database.close(); }
});

function databaseCount(database: DatabaseSync): unknown { return database.prepare("SELECT COUNT(*) AS n FROM monitor_snapshot").all()[0]?.n; }

it("reads all retained changes without repeats across bounded descending pages and rejects invalid cursors", async () => {
  const f = fixture();
  try {
    const insert = f.database.prepare("INSERT INTO monitor_change(subscription_id,snapshot_seq,detected_at,table_name,kind,key,materiality,label,change_json,delivered) VALUES (?,1,'now','datasets','changed',?,'info','test','{}',0)");
    for (let i = 1; i <= 405; i++) insert.run(subscription.id, String(i));
    insert.run("another-subscription", "foreign");
    const first = await (await f.call(`/changes?id=${subscription.id}`)).json() as any;
    expect(first.page).toMatchObject({ returned: 200, has_more: true, next_before_change_id: 206 });
    // A new event arriving between pages cannot shift or repeat the older page.
    insert.run(subscription.id, "newer");
    const second = await (await f.call(`/changes?id=${subscription.id}&before_change_id=${first.page.next_before_change_id}`)).json() as any;
    const third = await (await f.call(`/changes?id=${subscription.id}&before_change_id=${second.page.next_before_change_id}`)).json() as any;
    expect(third.page).toMatchObject({ returned: 5, has_more: false, next_before_change_id: null });
    expect([...first.changes, ...second.changes, ...third.changes].map(r => r.key)).toEqual(Array.from({ length: 405 }, (_, i) => String(405 - i)));
    for (const query of ["limit=0", "limit=201", "before_change_id=NaN", "before_change_id=0", "before_change_id=1.2"]) {
      expect((await f.call(`/changes?id=${subscription.id}&${query}`)).status).toBe(500);
    }
  } finally { f.database.close(); }
});

it("retains the last success if refreshing an existing watch fails", async () => {
  const f = fixture();
  try {
    await f.call("/create", subscription);
    const before = z.object({ last_success_at: z.string() }).parse(await (await f.call(`/status?id=${subscription.id}`)).json());
    f.service.fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    expect((await f.call("/create", { ...subscription, cadence_ms: 120000 })).status).toBe(500);
    expect(await (await f.call(`/status?id=${subscription.id}`)).json()).toMatchObject({ last_success_at: before.last_success_at, stale_after_ms: 240000, last_attempt: { outcome: "failure" } });
    expect(databaseCount(f.database)).toBe(1);
  } finally { f.database.close(); }
});

it("schedules a retry even when the first baseline fails", async () => {
  const f = fixture();
  try {
    f.service.fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    expect((await f.call("/create", subscription)).status).toBe(500);
    expect(await (await f.call(`/status?id=${subscription.id}`)).json()).toMatchObject({ freshness: "never_succeeded", last_attempt: { failure_kind: "transport_failure" } });
    expect(databaseCount(f.database)).toBe(0);
    expect(f.alarm).toHaveBeenCalledTimes(1);
  } finally { f.database.close(); }
});
