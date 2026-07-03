import { describe, expect, it } from "vitest";
import { classifyChanges, defaultMateriality } from "./materiality";
import type { RowChange } from "./types";

const make = (
	kind: RowChange["kind"],
	fields?: RowChange["fields"],
): RowChange => ({
	table: "t",
	kind,
	key: "k",
	keyValues: {},
	fields,
});

describe("defaultMateriality", () => {
	it("treats removals as high", () => {
		expect(defaultMateriality(make("removed"))).toBe("high");
	});
	it("treats additions as info", () => {
		expect(defaultMateriality(make("added"))).toBe("info");
	});
	it("treats a changed row with field deltas as high, without as info", () => {
		expect(
			defaultMateriality(
				make("changed", [{ field: "v", before: 1, after: 2 }]),
			),
		).toBe("high");
		expect(defaultMateriality(make("changed", []))).toBe("info");
	});
});

describe("classifyChanges", () => {
	it("applies a source classifier when provided", () => {
		const changes = [make("added")];
		classifyChanges(changes, () => ({ materiality: "high", label: "custom" }));
		expect(changes[0].materiality).toBe("high");
		expect(changes[0].label).toBe("custom");
	});
	it("falls back to the default when no classifier is given", () => {
		const changes = [make("removed")];
		classifyChanges(changes);
		expect(changes[0].materiality).toBe("high");
		expect(changes[0].label).toBeUndefined();
	});
});
