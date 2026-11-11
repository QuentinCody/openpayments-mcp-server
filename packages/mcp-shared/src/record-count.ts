function countWrappedRecords(data: object, depth: number): number | undefined {
	const wrappers = ["response", "data", "hits"].map(key => Reflect.get(data, key))
		.filter(value => value !== null && typeof value === "object");
	return wrappers.length === 1 ? countReturnedRecords(wrappers[0], depth + 1) : undefined;
}

/**
 * Length of one recognized records array in an otherwise unambiguous envelope.
 *
 * Deliberately conservative: with zero or several candidate arrays the shape is
 * ambiguous, and guessing wrong would mislabel a populated result as empty.
 * Upstream totals describe matching records, not the records in this result.
 * Follow only a single known wrapper, with a bounded depth.
 */
export function countReturnedRecords(data: unknown, depth = 0): number | undefined {
	if (Array.isArray(data)) return data.length;
	if (!data || typeof data !== "object" || depth > 2) return undefined;
	const arrays = Object.entries(data).filter(([, value]) => Array.isArray(value));
	if (arrays.length === 0) return countWrappedRecords(data, depth);
	if (arrays.length !== 1) return undefined;
	const [key, rows] = arrays[0];
	// Diagnostic arrays (e.g. RNAcentral QC's messages:[]) are not record sets.
	const recordKeys = ["results", "records", "entries", "items", "data", "hits", "curations", "documents", "nodes", "edges", "studies"];
	return recordKeys.includes(key) ? rows.length : undefined;
}
