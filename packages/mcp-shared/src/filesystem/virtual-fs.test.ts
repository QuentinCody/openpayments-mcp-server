/**
 * Unit tests for VirtualFS — SQLite-backed virtual filesystem.
 *
 * Uses a minimal in-memory SqlExec mock backed by a Map to simulate
 * SQLite behavior without requiring a real database.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { VirtualFS } from "./virtual-fs";
import type { SqlExec } from "../staging/chunking";

// ---------------------------------------------------------------------------
// Minimal SQLite mock — stores rows in a Map keyed by table name
// ---------------------------------------------------------------------------

interface MockRow {
	path: string;
	kind: string;
	content: string | null;
	size: number;
	created_at: string;
	modified_at: string;
}

function createMockSql(): SqlExec {
	const rows = new Map<string, MockRow>();
	const NOW = "2026-03-27 12:00:00";

	return {
		exec(query: string, ...bindings: unknown[]) {
			const sql = query.trim().replace(/\s+/g, " ");

			// CREATE TABLE — no-op (schema is implicit in our mock)
			if (sql.startsWith("CREATE TABLE")) {
				return { toArray: () => [], one: () => undefined };
			}

			// INSERT OR IGNORE — root dir (no bindings) or ensureParentDirs/mkdir (1 binding)
			// SQL: VALUES ('/', 'directory', 0) — no bindings
			// SQL: VALUES (?, 'directory', 0) — 1 binding (path), kind+size inline
			if (sql.includes("INSERT OR IGNORE INTO _fs_entries")) {
				if (bindings.length === 0) {
					// Root directory: all values inline in SQL
					if (!rows.has("/")) {
						rows.set("/", { path: "/", kind: "directory", content: null, size: 0, created_at: NOW, modified_at: NOW });
					}
				} else {
					const path = String(bindings[0]);
					if (!rows.has(path)) {
						rows.set(path, { path, kind: "directory", content: null, size: 0, created_at: NOW, modified_at: NOW });
					}
				}
				return { toArray: () => [], one: () => undefined };
			}

			// INSERT INTO ... ON CONFLICT (writeFile upsert)
			// SQL: VALUES (?, 'file', ?, ?, ...) — bindings: [path, content, size]
			if (sql.includes("INSERT INTO _fs_entries") && sql.includes("ON CONFLICT")) {
				const path = String(bindings[0]);
				rows.set(path, {
					path,
					kind: "file",
					content: String(bindings[1]),
					size: Number(bindings[2]),
					created_at: rows.get(path)?.created_at ?? NOW,
					modified_at: NOW,
				});
				return { toArray: () => [], one: () => undefined };
			}

			// INSERT INTO (no conflict — appendFile new file)
			// SQL: VALUES (?, 'file', ?, ?) — bindings: [path, content, size]
			if (sql.includes("INSERT INTO _fs_entries")) {
				const path = String(bindings[0]);
				rows.set(path, {
					path,
					kind: "file",
					content: bindings[1] != null ? String(bindings[1]) : null,
					size: Number(bindings[2] ?? 0),
					created_at: NOW,
					modified_at: NOW,
				});
				return { toArray: () => [], one: () => undefined };
			}

			// UPDATE (appendFile existing)
			if (sql.startsWith("UPDATE _fs_entries")) {
				const path = String(bindings[2]);
				const existing = rows.get(path);
				if (existing) {
					existing.content = String(bindings[0]);
					existing.size = Number(bindings[1]);
					existing.modified_at = NOW;
				}
				return { toArray: () => [], one: () => undefined };
			}

			// DELETE with LIKE
			if (sql.includes("DELETE FROM _fs_entries WHERE path LIKE")) {
				const likePattern = String(bindings[0]);
				const prefix = likePattern.replace(/%$/, "");
				for (const key of rows.keys()) {
					if (key.startsWith(prefix)) {
						rows.delete(key);
					}
				}
				return { toArray: () => [], one: () => undefined };
			}

			// DELETE exact
			if (sql.includes("DELETE FROM _fs_entries WHERE path =")) {
				rows.delete(String(bindings[0]));
				return { toArray: () => [], one: () => undefined };
			}

			// SELECT COUNT(*)
			if (sql.includes("SELECT COUNT(*)")) {
				const likePattern = String(bindings[0]);
				const prefix = likePattern.replace(/%$/, "");
				let count = 0;
				for (const key of rows.keys()) {
					if (key.startsWith(prefix)) count++;
				}
				return { toArray: () => [{ c: count }], one: () => ({ c: count }) };
			}

			// SELECT 1 (exists check)
			if (sql.includes("SELECT 1 FROM _fs_entries")) {
				const path = String(bindings[0]);
				const found = rows.has(path);
				return { toArray: () => (found ? [{ "1": 1 }] : []), one: () => (found ? { "1": 1 } : undefined) };
			}

			// SELECT kind FROM
			if (sql.includes("SELECT kind FROM _fs_entries")) {
				const path = String(bindings[0]);
				const row = rows.get(path);
				return { toArray: () => (row ? [{ kind: row.kind }] : []), one: () => (row ? { kind: row.kind } : undefined) };
			}

			// SELECT kind, content FROM (readFile)
			if (sql.includes("SELECT kind, content FROM _fs_entries")) {
				const path = String(bindings[0]);
				const row = rows.get(path);
				return { toArray: () => (row ? [{ kind: row.kind, content: row.content }] : []), one: () => (row ? { kind: row.kind, content: row.content } : undefined) };
			}

			// SELECT kind, content, size FROM (appendFile check)
			if (sql.includes("SELECT kind, content, size FROM _fs_entries")) {
				const path = String(bindings[0]);
				const row = rows.get(path);
				return { toArray: () => (row ? [{ kind: row.kind, content: row.content, size: row.size }] : []), one: () => undefined };
			}

			// SELECT path, kind, size, created_at, modified_at (stat)
			if (sql.includes("SELECT path, kind, size, created_at, modified_at")) {
				const path = String(bindings[0]);
				const row = rows.get(path);
				return { toArray: () => (row ? [{ path: row.path, kind: row.kind, size: row.size, created_at: row.created_at, modified_at: row.modified_at }] : []), one: () => undefined };
			}

			// SELECT path FROM ... LIKE (readdir — 3 bindings: path, prefix%, prefix%/%)
			if (sql.includes("SELECT path FROM _fs_entries WHERE path !=") && sql.includes("LIKE")) {
				const parentPath = String(bindings[0]);
				const likePrefix = String(bindings[1]).replace(/%$/, "");
				// bindings[2] is the NOT LIKE pattern — handled by remainder check below
				const result: Array<{ path: string }> = [];
				for (const [key, row] of rows) {
					if (key === parentPath) continue;
					if (!key.startsWith(likePrefix)) continue;
					// Exclude entries with additional / after the prefix
					const remainder = key.slice(likePrefix.length);
					if (remainder.includes("/")) continue;
					result.push({ path: row.path });
				}
				return { toArray: () => result, one: () => undefined };
			}

			// SELECT path FROM ... LIKE (glob)
			if (sql.includes("SELECT path FROM _fs_entries WHERE kind = 'file'")) {
				const sqlLikePattern = String(bindings[0]);
				const result: Array<{ path: string }> = [];
				for (const [key, row] of rows) {
					if (row.kind !== "file") continue;
					if (sqlLikeMatch(key, sqlLikePattern)) {
						result.push({ path: row.path });
					}
				}
				return { toArray: () => result, one: () => undefined };
			}

			return { toArray: () => [], one: () => undefined };
		},
	};
}

/** Simple SQL LIKE matcher for the mock. */
function sqlLikeMatch(value: string, pattern: string): boolean {
	let vi = 0;
	let pi = 0;
	let starPi = -1;
	let starVi = -1;

	while (vi < value.length) {
		if (pi < pattern.length && pattern[pi] === "\\") {
			// Escaped character — match literally
			pi++;
			if (pi < pattern.length && pattern[pi] === value[vi]) {
				pi++;
				vi++;
			} else {
				return false;
			}
		} else if (pi < pattern.length && pattern[pi] === "%") {
			starPi = pi + 1;
			starVi = vi;
			pi = starPi;
		} else if (pi < pattern.length && (pattern[pi] === "_" || pattern[pi] === value[vi])) {
			pi++;
			vi++;
		} else if (starPi !== -1) {
			starVi++;
			vi = starVi;
			pi = starPi;
		} else {
			return false;
		}
	}

	while (pi < pattern.length && pattern[pi] === "%") pi++;
	return pi === pattern.length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VirtualFS", () => {
	let sql: SqlExec;
	let vfs: VirtualFS;

	beforeEach(() => {
		sql = createMockSql();
		vfs = new VirtualFS(sql);
	});

	describe("writeFile + readFile", () => {
		it("roundtrips text content", () => {
			vfs.writeFile("/hello.txt", "world");
			expect(vfs.readFile("/hello.txt")).toBe("world");
		});

		it("overwrites existing file", () => {
			vfs.writeFile("/data.json", '{"a":1}');
			vfs.writeFile("/data.json", '{"b":2}');
			expect(vfs.readFile("/data.json")).toBe('{"b":2}');
		});

		it("returns path and size", () => {
			const result = vfs.writeFile("/test.txt", "hello");
			expect(result).toEqual({ path: "/test.txt", size: 5 });
		});

		it("auto-creates parent directories", () => {
			vfs.writeFile("/a/b/c.txt", "deep");
			expect(vfs.exists("/a")).toBe(true);
			expect(vfs.exists("/a/b")).toBe(true);
			expect(vfs.readFile("/a/b/c.txt")).toBe("deep");
		});

		it("throws on file too large", () => {
			const big = "x".repeat(1_048_577);
			expect(() => vfs.writeFile("/big.txt", big)).toThrow("File too large");
		});

		it("throws writing to root", () => {
			expect(() => vfs.writeFile("/", "data")).toThrow("Cannot write to root");
		});

		it("throws writing to a directory path", () => {
			vfs.mkdir("/mydir");
			expect(() => vfs.writeFile("/mydir", "data")).toThrow("path is a directory");
		});
	});

	describe("readFile errors", () => {
		it("throws on missing file", () => {
			expect(() => vfs.readFile("/nonexistent")).toThrow("File not found");
		});

		it("throws on directory", () => {
			vfs.mkdir("/mydir");
			expect(() => vfs.readFile("/mydir")).toThrow("Cannot read directory as file");
		});
	});

	describe("appendFile", () => {
		it("creates new file if not exists", () => {
			vfs.appendFile("/log.txt", "line1\n");
			expect(vfs.readFile("/log.txt")).toBe("line1\n");
		});

		it("appends to existing file", () => {
			vfs.writeFile("/log.txt", "line1\n");
			vfs.appendFile("/log.txt", "line2\n");
			expect(vfs.readFile("/log.txt")).toBe("line1\nline2\n");
		});

		it("throws appending to directory", () => {
			vfs.mkdir("/mydir");
			expect(() => vfs.appendFile("/mydir", "data")).toThrow("Cannot append to directory");
		});
	});

	describe("mkdir", () => {
		it("creates directory", () => {
			vfs.mkdir("/data");
			expect(vfs.exists("/data")).toBe(true);
			expect(vfs.stat("/data").kind).toBe("directory");
		});

		it("is idempotent", () => {
			vfs.mkdir("/data");
			vfs.mkdir("/data");
			expect(vfs.exists("/data")).toBe(true);
		});

		it("creates nested dirs recursively by default", () => {
			vfs.mkdir("/a/b/c");
			expect(vfs.exists("/a")).toBe(true);
			expect(vfs.exists("/a/b")).toBe(true);
			expect(vfs.exists("/a/b/c")).toBe(true);
		});

		it("throws creating dir where file exists", () => {
			vfs.writeFile("/myfile", "data");
			expect(() => vfs.mkdir("/myfile")).toThrow("path is a file");
		});

		it("no-ops on root", () => {
			vfs.mkdir("/");
			expect(vfs.exists("/")).toBe(true);
		});
	});

	describe("readdir", () => {
		it("lists direct children", () => {
			vfs.writeFile("/a.txt", "a");
			vfs.writeFile("/b.txt", "b");
			vfs.mkdir("/subdir");
			const entries = vfs.readdir("/");
			expect(entries.sort()).toEqual(["a.txt", "b.txt", "subdir"]);
		});

		it("does not list nested entries", () => {
			vfs.writeFile("/dir/child.txt", "c");
			vfs.writeFile("/dir/sub/deep.txt", "d");
			const entries = vfs.readdir("/dir");
			expect(entries.sort()).toEqual(["child.txt", "sub"]);
		});

		it("throws on missing directory", () => {
			expect(() => vfs.readdir("/nonexistent")).toThrow("Directory not found");
		});

		it("throws on file", () => {
			vfs.writeFile("/file.txt", "data");
			expect(() => vfs.readdir("/file.txt")).toThrow("Not a directory");
		});
	});

	describe("stat", () => {
		it("returns file metadata", () => {
			vfs.writeFile("/test.txt", "hello");
			const st = vfs.stat("/test.txt");
			expect(st.kind).toBe("file");
			expect(st.size).toBe(5);
			expect(st.path).toBe("/test.txt");
			expect(st.created_at).toBeDefined();
			expect(st.modified_at).toBeDefined();
		});

		it("returns directory metadata", () => {
			vfs.mkdir("/mydir");
			const st = vfs.stat("/mydir");
			expect(st.kind).toBe("directory");
			expect(st.size).toBe(0);
		});

		it("throws on missing path", () => {
			expect(() => vfs.stat("/nonexistent")).toThrow("Path not found");
		});
	});

	describe("exists", () => {
		it("returns true for existing file", () => {
			vfs.writeFile("/exists.txt", "yes");
			expect(vfs.exists("/exists.txt")).toBe(true);
		});

		it("returns true for existing directory", () => {
			vfs.mkdir("/mydir");
			expect(vfs.exists("/mydir")).toBe(true);
		});

		it("returns false for missing path", () => {
			expect(vfs.exists("/nope")).toBe(false);
		});

		it("returns true for root", () => {
			expect(vfs.exists("/")).toBe(true);
		});
	});

	describe("rm", () => {
		it("removes a file", () => {
			vfs.writeFile("/file.txt", "data");
			vfs.rm("/file.txt");
			expect(vfs.exists("/file.txt")).toBe(false);
		});

		it("removes directory recursively by default", () => {
			vfs.writeFile("/dir/a.txt", "a");
			vfs.writeFile("/dir/b.txt", "b");
			vfs.rm("/dir");
			expect(vfs.exists("/dir")).toBe(false);
			expect(vfs.exists("/dir/a.txt")).toBe(false);
		});

		it("throws removing non-empty dir with recursive=false", () => {
			vfs.writeFile("/dir/a.txt", "a");
			expect(() => vfs.rm("/dir", { recursive: false })).toThrow("Directory not empty");
		});

		it("throws removing root", () => {
			expect(() => vfs.rm("/")).toThrow("Cannot remove root");
		});

		it("throws on missing path", () => {
			expect(() => vfs.rm("/nonexistent")).toThrow("Path not found");
		});
	});

	describe("path normalization", () => {
		it("adds leading slash", () => {
			vfs.writeFile("file.txt", "data");
			expect(vfs.exists("/file.txt")).toBe(true);
		});

		it("rejects traversal patterns", () => {
			expect(() => vfs.writeFile("/../etc/passwd", "bad")).toThrow("traversal");
			expect(() => vfs.readFile("/foo/../../bar")).toThrow("traversal");
		});
	});

	describe("glob", () => {
		beforeEach(() => {
			vfs.writeFile("/data/a.json", "{}");
			vfs.writeFile("/data/b.json", "{}");
			vfs.writeFile("/data/c.txt", "text");
			vfs.writeFile("/data/sub/d.json", "{}");
			vfs.writeFile("/other/e.json", "{}");
		});

		it("matches with single * in directory", () => {
			const result = vfs.glob("/data/*.json");
			expect(result.matches.sort()).toEqual(["/data/a.json", "/data/b.json"]);
			expect(result.count).toBe(2);
		});

		it("single * does not cross directories", () => {
			const result = vfs.glob("/data/*.json");
			expect(result.matches).not.toContain("/data/sub/d.json");
		});

		it("matches with ** across directories", () => {
			const result = vfs.glob("/data/**/*.json");
			expect(result.matches.sort()).toEqual(["/data/a.json", "/data/b.json", "/data/sub/d.json"]);
		});

		it("matches all json files with **", () => {
			const result = vfs.glob("/**/*.json");
			expect(result.count).toBe(4);
		});
	});
});
