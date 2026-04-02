/**
 * VirtualFS — SQLite-backed virtual filesystem for Code Mode V8 isolates.
 *
 * Provides a persistent scratch filesystem within Durable Object SQLite.
 * Files written in one tool call persist and can be read in subsequent calls.
 *
 * Inspired by narumatt/sqlitefs schema design, reimplemented as a TypeScript
 * library with no Cloudflare or POSIX dependencies.
 */

import type { SqlExec } from "../staging/chunking";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FsStat {
	path: string;
	kind: "file" | "directory";
	size: number;
	created_at: string;
	modified_at: string;
}

export interface FsGlobResult {
	matches: string[];
	count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 1_048_576; // 1MB — DO SQLite cell limit is ~2MB

const DANGEROUS_PATTERNS = [
	/\.\.\//,  // directory traversal
	/\/\.\./,  // reverse traversal
	/%2e%2e/i, // URL-encoded traversal
];

// ---------------------------------------------------------------------------
// Glob matching — pure string comparison, no dynamic RegExp
// ---------------------------------------------------------------------------

/**
 * Match a path against a glob pattern containing single `*` (not `**`).
 * `*` matches any characters except `/`. `?` matches a single character.
 * Uses recursive descent — no RegExp construction.
 */
function matchSingleStarGlob(pattern: string, path: string): boolean {
	let pi = 0; // pattern index
	let si = 0; // string (path) index
	let starPi = -1; // pattern index after last *
	let starSi = -1; // string index at last * match

	while (si < path.length) {
		if (pi < pattern.length && (pattern[pi] === path[si] || pattern[pi] === "?")) {
			pi++;
			si++;
		} else if (pi < pattern.length && pattern[pi] === "*") {
			starPi = pi + 1;
			starSi = si;
			pi = starPi;
		} else if (starPi !== -1) {
			// Backtrack: advance the string position for the last *
			starSi++;
			// * must not cross directory boundaries
			if (path[starSi - 1] === "/") return false;
			si = starSi;
			pi = starPi;
		} else {
			return false;
		}
	}

	// Consume trailing *'s in pattern
	while (pi < pattern.length && pattern[pi] === "*") {
		pi++;
	}

	return pi === pattern.length;
}

// ---------------------------------------------------------------------------
// VirtualFS
// ---------------------------------------------------------------------------

export class VirtualFS {
	#sql: SqlExec;
	#initialized = false;

	constructor(sql: SqlExec) {
		this.#sql = sql;
	}

	// -----------------------------------------------------------------------
	// Schema
	// -----------------------------------------------------------------------

	private ensureSchema(): void {
		if (this.#initialized) return;
		this.#sql.exec(`
			CREATE TABLE IF NOT EXISTS _fs_entries (
				path        TEXT PRIMARY KEY,
				kind        TEXT NOT NULL DEFAULT 'file',
				content     TEXT,
				size        INTEGER NOT NULL DEFAULT 0,
				created_at  TEXT NOT NULL DEFAULT (datetime('now')),
				modified_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		// Ensure root directory exists
		this.#sql.exec(
			`INSERT OR IGNORE INTO _fs_entries (path, kind, size) VALUES ('/', 'directory', 0)`,
		);
		this.#initialized = true;
	}

	// -----------------------------------------------------------------------
	// Path utilities
	// -----------------------------------------------------------------------

	private normalizePath(raw: string): string {
		if (!raw || raw === "/") return "/";
		// Must start with /
		let normalized = raw.startsWith("/") ? raw : `/${raw}`;
		// Reject dangerous patterns
		for (const pattern of DANGEROUS_PATTERNS) {
			if (pattern.test(normalized)) {
				throw new Error(`Invalid path: contains traversal pattern: ${normalized}`);
			}
		}
		// Collapse duplicate slashes, remove trailing slash
		normalized = normalized.replace(/\/+/g, "/").replace(/\/$/, "");
		return normalized || "/";
	}

	private parentPath(p: string): string {
		if (p === "/") return "/";
		const lastSlash = p.lastIndexOf("/");
		return lastSlash === 0 ? "/" : p.slice(0, lastSlash);
	}

	private baseName(p: string): string {
		if (p === "/") return "/";
		return p.slice(p.lastIndexOf("/") + 1);
	}

	/** Create all ancestor directories for a path (not the path itself). */
	private ensureParentDirs(fullPath: string): void {
		const parts = fullPath.split("/").filter(Boolean);
		let current = "";
		for (let i = 0; i < parts.length - 1; i++) {
			current = `${current}/${parts[i]}`;
			this.#sql.exec(
				`INSERT OR IGNORE INTO _fs_entries (path, kind, size) VALUES (?, 'directory', 0)`,
				current,
			);
		}
	}

	// -----------------------------------------------------------------------
	// File operations
	// -----------------------------------------------------------------------

	writeFile(filePath: string, content: string): { path: string; size: number } {
		this.ensureSchema();
		const normalized = this.normalizePath(filePath);
		if (normalized === "/") throw new Error("Cannot write to root directory");

		const size = content.length;
		if (size > MAX_FILE_SIZE) {
			throw new Error(`File too large: ${size} bytes (max ${MAX_FILE_SIZE})`);
		}

		this.ensureParentDirs(normalized);

		// Check if path exists as directory
		const existing = this.#sql.exec(
			`SELECT kind FROM _fs_entries WHERE path = ?`,
			normalized,
		).toArray();
		if (existing.length > 0 && existing[0].kind === "directory") {
			throw new Error(`Cannot write file: path is a directory: ${normalized}`);
		}

		this.#sql.exec(
			`INSERT INTO _fs_entries (path, kind, content, size, modified_at)
			 VALUES (?, 'file', ?, ?, datetime('now'))
			 ON CONFLICT(path) DO UPDATE SET
			   content = excluded.content,
			   size = excluded.size,
			   modified_at = datetime('now')`,
			normalized,
			content,
			size,
		);

		return { path: normalized, size };
	}

	appendFile(filePath: string, content: string): { path: string; size: number } {
		this.ensureSchema();
		const normalized = this.normalizePath(filePath);
		if (normalized === "/") throw new Error("Cannot append to root directory");

		const existing = this.#sql.exec(
			`SELECT kind, content, size FROM _fs_entries WHERE path = ?`,
			normalized,
		).toArray();

		if (existing.length > 0 && existing[0].kind === "directory") {
			throw new Error(`Cannot append to directory: ${normalized}`);
		}

		const existingContent = existing.length > 0 ? String(existing[0].content ?? "") : "";
		const newContent = existingContent + content;
		const size = newContent.length;

		if (size > MAX_FILE_SIZE) {
			throw new Error(`File too large after append: ${size} bytes (max ${MAX_FILE_SIZE})`);
		}

		if (existing.length === 0) {
			this.ensureParentDirs(normalized);
			this.#sql.exec(
				`INSERT INTO _fs_entries (path, kind, content, size) VALUES (?, 'file', ?, ?)`,
				normalized,
				newContent,
				size,
			);
		} else {
			this.#sql.exec(
				`UPDATE _fs_entries SET content = ?, size = ?, modified_at = datetime('now') WHERE path = ?`,
				newContent,
				size,
				normalized,
			);
		}

		return { path: normalized, size };
	}

	readFile(filePath: string): string {
		this.ensureSchema();
		const normalized = this.normalizePath(filePath);

		const rows = this.#sql.exec(
			`SELECT kind, content FROM _fs_entries WHERE path = ?`,
			normalized,
		).toArray();

		if (rows.length === 0) {
			throw new Error(`File not found: ${normalized}`);
		}
		if (rows[0].kind === "directory") {
			throw new Error(`Cannot read directory as file: ${normalized}`);
		}

		return String(rows[0].content ?? "");
	}

	// -----------------------------------------------------------------------
	// Directory operations
	// -----------------------------------------------------------------------

	mkdir(dirPath: string, options?: { recursive?: boolean }): void {
		this.ensureSchema();
		const normalized = this.normalizePath(dirPath);
		if (normalized === "/") return; // root always exists

		const recursive = options?.recursive !== false; // default true

		if (recursive) {
			this.ensureParentDirs(normalized);
		} else {
			const parent = this.parentPath(normalized);
			const parentRows = this.#sql.exec(
				`SELECT kind FROM _fs_entries WHERE path = ?`,
				parent,
			).toArray();
			if (parentRows.length === 0) {
				throw new Error(`Parent directory does not exist: ${parent}`);
			}
		}

		const existing = this.#sql.exec(
			`SELECT kind FROM _fs_entries WHERE path = ?`,
			normalized,
		).toArray();
		if (existing.length > 0 && existing[0].kind === "file") {
			throw new Error(`Cannot create directory: path is a file: ${normalized}`);
		}

		this.#sql.exec(
			`INSERT OR IGNORE INTO _fs_entries (path, kind, size) VALUES (?, 'directory', 0)`,
			normalized,
		);
	}

	readdir(dirPath: string): string[] {
		this.ensureSchema();
		const normalized = this.normalizePath(dirPath);

		const dirRows = this.#sql.exec(
			`SELECT kind FROM _fs_entries WHERE path = ?`,
			normalized,
		).toArray();
		if (dirRows.length === 0) {
			throw new Error(`Directory not found: ${normalized}`);
		}
		if (dirRows[0].kind !== "directory") {
			throw new Error(`Not a directory: ${normalized}`);
		}

		const prefix = normalized === "/" ? "/" : `${normalized}/`;
		const rows = this.#sql.exec(
			`SELECT path FROM _fs_entries WHERE path != ? AND path LIKE ? AND path NOT LIKE ?`,
			normalized,
			`${prefix}%`,
			`${prefix}%/%`,
		).toArray();

		return rows.map((r) => this.baseName(String(r.path)));
	}

	// -----------------------------------------------------------------------
	// Metadata operations
	// -----------------------------------------------------------------------

	stat(filePath: string): FsStat {
		this.ensureSchema();
		const normalized = this.normalizePath(filePath);

		const rows = this.#sql.exec(
			`SELECT path, kind, size, created_at, modified_at FROM _fs_entries WHERE path = ?`,
			normalized,
		).toArray();

		if (rows.length === 0) {
			throw new Error(`Path not found: ${normalized}`);
		}

		const row = rows[0];
		return {
			path: String(row.path),
			kind: String(row.kind) as "file" | "directory",
			size: Number(row.size),
			created_at: String(row.created_at),
			modified_at: String(row.modified_at),
		};
	}

	exists(filePath: string): boolean {
		this.ensureSchema();
		const normalized = this.normalizePath(filePath);

		const rows = this.#sql.exec(
			`SELECT 1 FROM _fs_entries WHERE path = ?`,
			normalized,
		).toArray();

		return rows.length > 0;
	}

	// -----------------------------------------------------------------------
	// Removal
	// -----------------------------------------------------------------------

	rm(filePath: string, options?: { recursive?: boolean }): void {
		this.ensureSchema();
		const normalized = this.normalizePath(filePath);
		if (normalized === "/") throw new Error("Cannot remove root directory");

		const rows = this.#sql.exec(
			`SELECT kind FROM _fs_entries WHERE path = ?`,
			normalized,
		).toArray();

		if (rows.length === 0) {
			throw new Error(`Path not found: ${normalized}`);
		}

		const recursive = options?.recursive !== false; // default true

		if (rows[0].kind === "directory") {
			const prefix = `${normalized}/`;
			const children = this.#sql.exec(
				`SELECT COUNT(*) as c FROM _fs_entries WHERE path LIKE ?`,
				`${prefix}%`,
			).toArray();
			const childCount = Number(children[0]?.c ?? 0);

			if (childCount > 0 && !recursive) {
				throw new Error(`Directory not empty: ${normalized}`);
			}

			if (childCount > 0) {
				this.#sql.exec(
					`DELETE FROM _fs_entries WHERE path LIKE ?`,
					`${prefix}%`,
				);
			}
		}

		this.#sql.exec(`DELETE FROM _fs_entries WHERE path = ?`, normalized);
	}

	// -----------------------------------------------------------------------
	// Glob
	// -----------------------------------------------------------------------

	glob(pattern: string): FsGlobResult {
		this.ensureSchema();

		// Convert glob pattern to SQL LIKE pattern
		// SQL LIKE % matches anything including /, so ** and * both become %
		// The distinction (single * shouldn't cross /) is handled by post-filtering
		let sqlPattern = pattern;

		// Escape SQL LIKE special chars first
		sqlPattern = sqlPattern.replace(/%/g, "\\%").replace(/_/g, "\\_");

		// Replace **/ with % (matches zero or more directories)
		sqlPattern = sqlPattern.replace(/\*\*\//g, "%");
		// Replace remaining ** with %
		sqlPattern = sqlPattern.replace(/\*\*/g, "%");
		// Replace single * with %
		sqlPattern = sqlPattern.replace(/\*/g, "%");
		// Replace ? with _
		sqlPattern = sqlPattern.replace(/\?/g, "_");

		// Ensure pattern starts with /
		if (!sqlPattern.startsWith("/")) {
			sqlPattern = `/%${sqlPattern}`;
		}

		const rows = this.#sql.exec(
			`SELECT path FROM _fs_entries WHERE kind = 'file' AND path LIKE ? ESCAPE '\\'`,
			sqlPattern,
		).toArray();

		let matches = rows.map((r) => String(r.path));

		// Post-filter for single * (shouldn't cross directory boundaries)
		if (pattern.includes("*") && !pattern.includes("**")) {
			matches = matches.filter((p) => matchSingleStarGlob(pattern, p));
		}

		return { matches, count: matches.length };
	}
}
