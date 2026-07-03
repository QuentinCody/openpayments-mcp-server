import { describe, expect, it } from "vitest";
import {
	buildSnapshotRow,
	GENESIS_HASH,
	type SnapshotRow,
	verifyChainRows,
} from "./snapshot-chain";

const INPUT = {
	subscriptionId: "sub_1",
	queryDescriptorHash: "qd",
	contentHash: "ch",
	payloadJson: '{"x":1}',
};
const TS = "2026-06-19T00:00:00.000Z";

async function chain(n: number): Promise<SnapshotRow[]> {
	const rows: SnapshotRow[] = [];
	let prevSeq = 0;
	let prevHash = GENESIS_HASH;
	for (let i = 0; i < n; i++) {
		const row = await buildSnapshotRow(
			prevSeq,
			prevHash,
			{ ...INPUT, contentHash: `ch${i}`, payloadJson: `{"x":${i}}` },
			{ createdAt: TS },
		);
		rows.push(row);
		prevSeq = row.seq;
		prevHash = row.entry_hash;
	}
	return rows;
}

describe("buildSnapshotRow", () => {
	it("assigns seq=prev+1, links prev_hash, and hashes payload + entry", async () => {
		const r = await buildSnapshotRow(0, GENESIS_HASH, INPUT, { createdAt: TS });
		expect(r.seq).toBe(1);
		expect(r.prev_hash).toBe(GENESIS_HASH);
		expect(r.entry_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(r.payload_hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("verifyChainRows", () => {
	it("accepts an intact chain and returns the head hash", async () => {
		const rows = await chain(3);
		const v = await verifyChainRows(rows);
		expect(v.valid).toBe(true);
		expect(v.count).toBe(3);
		expect(v.head).toBe(rows[2].entry_hash);
	});

	it("detects payload tampering", async () => {
		const rows = await chain(2);
		rows[1].payload_json = '{"x":999}';
		const v = await verifyChainRows(rows);
		expect(v.valid).toBe(false);
		expect(v.brokenSeq).toBe(2);
	});

	it("detects a deleted row as a sequence break", async () => {
		const rows = await chain(3);
		const v = await verifyChainRows([rows[0], rows[2]]);
		expect(v.valid).toBe(false);
		expect(v.brokenSeq).toBe(3);
	});

	it("detects metadata tampering (content_hash is covered by entry_hash)", async () => {
		const rows = await chain(2);
		rows[1].content_hash = "tampered";
		const v = await verifyChainRows(rows);
		expect(v.valid).toBe(false);
		expect(v.brokenSeq).toBe(2);
	});
});
