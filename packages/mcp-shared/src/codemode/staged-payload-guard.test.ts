import { describe, expect, it } from "vitest";
import { STAGED_PAYLOAD_GUARD_SOURCE } from "./staged-payload-guard";

type WrappedStaged = Record<string, unknown> & {
	map: (fn: (value: unknown) => unknown) => unknown;
};

function wrapperFrom(source: string): (raw: unknown) => WrappedStaged {
	const factory = new Function(
		"__stagedResults",
		`${source}\nreturn __wrapStaged;`,
	);
	return factory([]) as (raw: unknown) => WrappedStaged;
}

function capturedError(read: () => unknown): Error & { code?: string } {
	try {
		read();
		throw new Error("expected staged access to throw");
	} catch (error) {
		return error as Error & { code?: string };
	}
}

describe("shared serialized staged-payload guard", () => {
	it("throws one stable machine-readable error after JSON serialization", () => {
		const wrap = wrapperFrom(STAGED_PAYLOAD_GUARD_SOURCE);
		const staged = wrap(
			JSON.parse(
				JSON.stringify({
					__staged: true,
					data_access_id: "shared_1",
					total_rows: 42,
				}),
			),
		);
		const error = capturedError(
			() => (staged as { results?: unknown[] }).results ?? [],
		);
		expect(error.code).toBe("STAGED_PAYLOAD_ACCESS");
		expect(error.message).toContain("not an empty result");
		expect(error.message).toContain("shared_1");
		expect(staged.data_access_id).toBe("shared_1");
	});

	it("gives array-method misuse the same stable code", () => {
		const staged = wrapperFrom(STAGED_PAYLOAD_GUARD_SOURCE)({
			__staged: true,
			data_access_id: "shared_2",
		});
		const error = capturedError(() => staged.map(() => 0));
		expect(error.code).toBe("STAGED_PAYLOAD_ACCESS");
		expect(error.message).toContain(".map()");
	});
});
