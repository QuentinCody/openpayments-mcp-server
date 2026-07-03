// interlinked-tdd: exempt -- thin Durable Object shell over unit-tested pure
// helpers (run-once / diff / snapshot-chain / internal-call). DO routing and the
// self-rescheduling alarm are integration-tested via wrangler dev.
import { DurableObject } from "cloudflare:workers";
import { canonicalJson, sha256Hex } from "../provenance/provenance";
import { extractRowSets } from "./canonicalize";
import { callTool, type McpRpcStub } from "./internal-call";
import { runOnce } from "./run-once";
import {
	appendSnapshot,
	type SnapshotRow,
	type SqlRunner,
	verifySnapshotChain,
} from "./snapshot-chain";
import { SOURCES } from "./sources/index";

interface MonitorEnv {
	MONITOR_DO: DurableObjectNamespace;
	/** Cross-script binding to fda-orange-book-mcp-server's MyMCP DO (in-fabric, no public hop). */
	SRV_FDA_ORANGE_BOOK: DurableObjectNamespace;
}

interface SubscriptionRow {
	id: string;
	source_id: string;
	input_json: string;
	cadence_ms: number;
	status: string;
	created_at: string;
	last_checked_at: string | null;
	last_content_hash: string | null;
}

interface MonitorChangeRow {
	id: number;
	subscription_id: string;
	snapshot_seq: number;
	detected_at: string;
	table_name: string;
	kind: string;
	key: string;
	materiality: string | null;
	label: string | null;
	change_json: string;
	delivered: number;
}

interface CreateBody {
	id: string;
	source_id: string;
	input: Record<string, unknown>;
	cadence_ms: number;
}

interface CheckResult {
	ok: boolean;
	reason?: string;
	unchanged?: boolean;
	baseline?: boolean;
	changes?: number;
	snapshot_seq?: number;
	head?: string;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** One Durable Object per subscription (idFromName `sub:<id>`): owns its snapshot chain + alarm. */
export class MonitorDO extends DurableObject<MonitorEnv> {
	private readonly sql: SqlRunner;
	private callId = 0;

	constructor(ctx: DurableObjectState, env: MonitorEnv) {
		super(ctx, env);
		this.sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
			this.ctx.storage.sql
				.exec(strings.join("?"), ...values)
				.toArray()) as SqlRunner;
		ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	private migrate(): void {
		this.sql`CREATE TABLE IF NOT EXISTS subscription (
			id TEXT PRIMARY KEY, source_id TEXT NOT NULL, input_json TEXT NOT NULL,
			cadence_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL, last_checked_at TEXT, last_content_hash TEXT
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS monitor_snapshot (
			seq INTEGER NOT NULL, subscription_id TEXT NOT NULL, query_descriptor_hash TEXT NOT NULL,
			content_hash TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
			diff_json TEXT, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL, created_at TEXT NOT NULL,
			PRIMARY KEY (subscription_id, seq)
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS monitor_change (
			id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id TEXT NOT NULL, snapshot_seq INTEGER NOT NULL,
			detected_at TEXT NOT NULL, table_name TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
			materiality TEXT, label TEXT, change_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
		)`;
	}

	private nextId(): number {
		this.callId += 1;
		return this.callId;
	}

	private async stubFor(server: string): Promise<McpRpcStub> {
		const bindings: Record<string, DurableObjectNamespace | undefined> = {
			"fda-orange-book": this.env.SRV_FDA_ORANGE_BOOK,
		};
		const ns = bindings[server];
		if (!ns)
			throw new Error(`monitor: no in-fabric binding for server '${server}'`);
		// Stable session name keeps one warm RPC session across ticks. Agents-SDK DOs
		// require their name set before any RPC method is called (workerd #2240).
		const name = `rpc:monitor:${server}`;
		const stub = ns.get(ns.idFromName(name)) as unknown as McpRpcStub;
		await (stub as { setName?: (n: string) => Promise<unknown> }).setName?.(
			name,
		);
		return stub;
	}

	private loadSub(id: string): SubscriptionRow | null {
		return (
			(
				this
					.sql`SELECT * FROM subscription WHERE id = ${id} LIMIT 1` as unknown as SubscriptionRow[]
			)[0] ?? null
		);
	}

	private firstActiveSub(): SubscriptionRow | null {
		return (
			(
				this
					.sql`SELECT * FROM subscription WHERE status = 'active' ORDER BY created_at LIMIT 1` as unknown as SubscriptionRow[]
			)[0] ?? null
		);
	}

	private latestSnapshot(subId: string): SnapshotRow | null {
		return (
			(
				this
					.sql`SELECT * FROM monitor_snapshot WHERE subscription_id = ${subId} ORDER BY seq DESC LIMIT 1` as unknown as SnapshotRow[]
			)[0] ?? null
		);
	}

	/** One monitor tick: re-run the saved query, diff vs the last snapshot, append + record changes. */
	private async check(subId: string): Promise<CheckResult> {
		const sub = this.loadSub(subId);
		if (!sub) return { ok: false, reason: "no such subscription" };
		if (sub.status !== "active")
			return { ok: false, reason: `subscription is ${sub.status}` };
		const source = SOURCES[sub.source_id];
		if (!source) throw new Error(`monitor: unknown source '${sub.source_id}'`);

		const latest = this.latestSnapshot(subId);
		const priorRowSets = latest
			? extractRowSets(JSON.parse(latest.payload_json), source.profile)
			: null;

		const result = await runOnce({
			source,
			input: JSON.parse(sub.input_json) as Record<string, unknown>,
			run: async (q) =>
				callTool(await this.stubFor(q.server), q.tool, q.params, this.nextId()),
			priorRowSets,
			priorContentHash: latest?.content_hash ?? null,
		});

		const now = new Date().toISOString();
		if (latest && result.unchanged) {
			this
				.sql`UPDATE subscription SET last_checked_at = ${now} WHERE id = ${subId}`;
			return { ok: true, unchanged: true, changes: 0, head: latest.entry_hash };
		}

		const payloadJson = canonicalJson(result.cleaned);
		const queryDescriptorHash = await sha256Hex(canonicalJson(result.query));
		const appended = await appendSnapshot(this.sql, {
			subscriptionId: subId,
			queryDescriptorHash,
			contentHash: result.contentHash,
			payloadJson,
			diffJson: latest ? JSON.stringify(result.diff) : null,
		});
		for (const c of result.changes) {
			this.sql`INSERT INTO monitor_change
				(subscription_id, snapshot_seq, detected_at, table_name, kind, key, materiality, label, change_json)
				VALUES (${subId}, ${appended.seq}, ${now}, ${c.table}, ${c.kind}, ${c.key}, ${c.materiality ?? null}, ${c.label ?? null}, ${JSON.stringify(c)})`;
		}
		this
			.sql`UPDATE subscription SET last_checked_at = ${now}, last_content_hash = ${result.contentHash} WHERE id = ${subId}`;
		return {
			ok: true,
			unchanged: false,
			baseline: !latest,
			changes: result.changes.length,
			snapshot_seq: appended.seq,
			head: appended.entry_hash,
		};
	}

	private async create(body: CreateBody): Promise<CheckResult> {
		const now = new Date().toISOString();
		this
			.sql`INSERT OR REPLACE INTO subscription (id, source_id, input_json, cadence_ms, status, created_at)
			VALUES (${body.id}, ${body.source_id}, ${JSON.stringify(body.input)}, ${body.cadence_ms}, 'active', ${now})`;
		const baseline = await this.check(body.id); // establish snapshot 1
		await this.ctx.storage.setAlarm(Date.now() + body.cadence_ms);
		return baseline;
	}

	private async changes(id: string): Promise<unknown> {
		const rows = this
			.sql`SELECT * FROM monitor_change WHERE subscription_id = ${id} ORDER BY id DESC LIMIT 200` as unknown as MonitorChangeRow[];
		const head = this.latestSnapshot(id);
		const chain = await verifySnapshotChain(this.sql, id);
		return {
			ok: true,
			subscription_id: id,
			changes: rows.map((r) => ({
				detected_at: r.detected_at,
				table: r.table_name,
				kind: r.kind,
				key: r.key,
				materiality: r.materiality,
				label: r.label,
			})),
			snapshots: chain.count,
			head_hash: head?.entry_hash ?? null,
			provenance: {
				intact: chain.valid,
				head: chain.head,
				broken_seq: chain.brokenSeq,
				reason: chain.reason,
			},
		};
	}

	async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		const sub = this.firstActiveSub();
		if (!sub) return;
		try {
			await this.check(sub.id);
		} catch (err) {
			if ((alarmInfo?.retryCount ?? 0) >= 5) {
				await this.ctx.storage.setAlarm(Date.now() + 30_000);
				return;
			}
			throw err; // let CF retry with exponential backoff
		}
		// Reschedule on success only; drift-free (now + cadence), and only while active.
		const still = this.firstActiveSub();
		if (still) await this.ctx.storage.setAlarm(Date.now() + still.cadence_ms);
	}

	async fetch(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const path = url.pathname;
			if (req.method === "POST" && path === "/create") {
				return json(await this.create((await req.json()) as CreateBody));
			}
			if (req.method === "POST" && path === "/check_now") {
				return json(
					await this.check(((await req.json()) as { id: string }).id),
				);
			}
			if (req.method === "GET" && path === "/changes") {
				return json(await this.changes(url.searchParams.get("id") ?? ""));
			}
			if (req.method === "POST" && path === "/pause") {
				const { id } = (await req.json()) as { id: string };
				this.sql`UPDATE subscription SET status = 'paused' WHERE id = ${id}`;
				return json({ ok: true });
			}
			return json({ ok: false, error: "not found" }, 404);
		} catch (err) {
			return json(
				{ ok: false, error: err instanceof Error ? err.message : String(err) },
				500,
			);
		}
	}
}
