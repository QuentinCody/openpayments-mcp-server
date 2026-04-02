/**
 * Filesystem proxy source — pure JS injected into V8 isolates.
 *
 * Provides:
 *   fs.readFile(path)           — read file content as string
 *   fs.writeFile(path, content) — write string (auto-stringifies objects)
 *   fs.appendFile(path, content)— append to file (creates if missing)
 *   fs.mkdir(path, opts?)       — create directory (recursive by default)
 *   fs.readdir(path)            — list directory entries
 *   fs.stat(path)               — get file/directory metadata
 *   fs.exists(path)             — check if path exists
 *   fs.rm(path, opts?)          — remove file or directory
 *   fs.glob(pattern)            — glob pattern matching
 *   fs.readJSON(path)           — readFile + JSON.parse (no extra RPC)
 *   fs.writeJSON(path, data)    — JSON.stringify + writeFile (no extra RPC)
 *
 * All operations persist in DO SQLite across tool calls within a session.
 * API keys and network access are not involved — this is pure storage.
 */

/**
 * Returns the JS source string to inject into V8 isolates.
 * Relies on `codemode` proxy being available (from evaluator prefix).
 */
export function buildFsProxySource(): string {
	return `
// --- Filesystem proxy helpers (injected) ---
var fs = {
  readFile: async function(path) {
    var result = await codemode.__fs_read({ path: path });
    if (result && result.__fs_error) throw new Error(result.message || "fs.readFile failed");
    return result;
  },

  writeFile: async function(path, content) {
    if (typeof content === "object" && content !== null) {
      content = JSON.stringify(content, null, 2);
    }
    var result = await codemode.__fs_write({ path: path, content: String(content) });
    if (result && result.__fs_error) throw new Error(result.message || "fs.writeFile failed");
    return result;
  },

  appendFile: async function(path, content) {
    if (typeof content === "object" && content !== null) {
      content = JSON.stringify(content, null, 2);
    }
    var result = await codemode.__fs_append({ path: path, content: String(content) });
    if (result && result.__fs_error) throw new Error(result.message || "fs.appendFile failed");
    return result;
  },

  mkdir: async function(path, options) {
    var result = await codemode.__fs_mkdir({
      path: path,
      recursive: options && options.recursive !== undefined ? options.recursive : true,
    });
    if (result && result.__fs_error) throw new Error(result.message || "fs.mkdir failed");
    return result;
  },

  readdir: async function(path) {
    var result = await codemode.__fs_readdir({ path: path || "/" });
    if (result && result.__fs_error) throw new Error(result.message || "fs.readdir failed");
    return result;
  },

  stat: async function(path) {
    var result = await codemode.__fs_stat({ path: path });
    if (result && result.__fs_error) throw new Error(result.message || "fs.stat failed");
    return result;
  },

  exists: async function(path) {
    var result = await codemode.__fs_exists({ path: path });
    if (result && result.__fs_error) throw new Error(result.message || "fs.exists failed");
    return result;
  },

  rm: async function(path, options) {
    var result = await codemode.__fs_rm({
      path: path,
      recursive: options && options.recursive !== undefined ? options.recursive : true,
    });
    if (result && result.__fs_error) throw new Error(result.message || "fs.rm failed");
    return result;
  },

  glob: async function(pattern) {
    var result = await codemode.__fs_glob({ pattern: pattern });
    if (result && result.__fs_error) throw new Error(result.message || "fs.glob failed");
    return result;
  },

  /** Read a JSON file and parse it. No extra RPC — uses readFile internally. */
  readJSON: async function(path) {
    var content = await codemode.__fs_read({ path: path });
    if (content && content.__fs_error) throw new Error(content.message || "fs.readJSON failed");
    return JSON.parse(content);
  },

  /** Write an object as formatted JSON. No extra RPC — uses writeFile internally. */
  writeJSON: async function(path, data) {
    var json = JSON.stringify(data, null, 2);
    var result = await codemode.__fs_write({ path: path, content: json });
    if (result && result.__fs_error) throw new Error(result.message || "fs.writeJSON failed");
    return result;
  },
};
// --- End filesystem proxy helpers ---
`;
}
