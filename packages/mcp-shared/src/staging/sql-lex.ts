/**
 * Minimal, allocation-light SQL lexing primitives for the read-only guard and
 * the LIMIT rewriter. Every check in `sql-guard.ts` that scans for a keyword, a
 * comment, or a statement separator must first know what is CODE and what is
 * DATA — a keyword inside a string literal is not a command, and a `--` inside a
 * string is not a comment.
 *
 * SECURITY NOTE: the guard's job is to reject writes. These helpers only ever
 * BLANK the contents of quoted regions or STRIP comments — a write command
 * keyword must appear bare to execute, so it can never hide inside a quoted
 * region and still run. The doubling-escape handling (`''` `""` `` `` ``) is
 * load-bearing for that guarantee: mis-reading an escaped quote as a close+open
 * would expose or conceal following code, so it is tested in both directions
 * (`sql-lex.test.ts`).
 *
 * All three functions are single-pass and linear — no regex, so no
 * backtracking blowup on caller-controlled input.
 */

// Doubling-escaped quote styles: ' (string), " and ` (identifiers). SQLite also
// accepts [bracket] identifiers (MSSQL-compat), which are asymmetric (open [,
// close ]) and have NO escape — a ] always closes. Every scanner below routes
// quoted regions through endOfQuoted so all four styles are treated as data, not
// code; missing brackets let "SELECT 1 AS [x--y]; <write>" hide its chained
// write from the guard (rs2 #1).
const QUOTES = new Set(["'", '"', "`"]);

/** True if `ch` opens a quoted literal / identifier region. */
function opensQuote(ch: string): boolean {
	return ch === "[" || QUOTES.has(ch);
}

/**
 * Index just past a quoted region that OPENS at `start`. Doubling escape for
 * ' " ` (a repeated delimiter stays inside); no escape for [ ] (first ] closes).
 * An unterminated region runs to end of string.
 */
export function endOfQuoted(s: string, start: number): number {
	const open = s[start];
	let j = start + 1;
	if (open === "[") {
		while (j < s.length && s[j] !== "]") j++;
		return j < s.length ? j + 1 : j;
	}
	while (j < s.length) {
		if (s[j] === open) {
			if (s[j + 1] === open) {
				j += 2; // doubled = escaped literal delimiter, still inside
				continue;
			}
			return j + 1; // real close
		}
		j++;
	}
	return j; // unterminated
}

/**
 * Replace the CONTENTS of every quoted literal / identifier with spaces,
 * preserving the delimiters and the overall length (so indices into the result
 * map 1:1 onto the input). `'insert'` → `'      '`, `[x--y]` → `[    ]`; a bare
 * `INSERT` outside any quote is untouched.
 */
export function blankQuotedLiterals(sql: string): string {
	const s = String(sql);
	let out = "";
	let i = 0;
	while (i < s.length) {
		if (opensQuote(s[i])) {
			const end = endOfQuoted(s, i);
			const close = s[i] === "[" ? "]" : s[i];
			const hasClose = end > i + 1 && s[end - 1] === close;
			const inner = hasClose ? end - 1 : end;
			out += s[i]; // opening delimiter
			for (let j = i + 1; j < inner; j++) out += " ";
			if (hasClose) out += close;
			i = end;
			continue;
		}
		out += s[i];
		i++;
	}
	return out;
}

/**
 * Remove `--` line comments that are in CODE (not inside a quoted region), from
 * the `--` to the end of that line. A `--` inside a string/identifier is
 * preserved: `WHERE n = 'a -- b'` and `[a--b]` are unchanged, but
 * `SELECT 1 -- drop` becomes `SELECT 1 `.
 */
export function stripLineComments(sql: string): string {
	const s = String(sql);
	let out = "";
	let i = 0;
	while (i < s.length) {
		if (opensQuote(s[i])) {
			const end = endOfQuoted(s, i);
			out += s.slice(i, end); // copy the quoted region verbatim
			i = end;
			continue;
		}
		if (s[i] === "-" && s[i + 1] === "-") {
			while (i < s.length && s[i] !== "\n") i++; // drop to end of line
			continue;
		}
		out += s[i];
		i++;
	}
	return out;
}

/**
 * Strip a trailing run of whitespace and `;` — linear, so it cannot exhibit the
 * O(n²) backtracking of `/;+\s*$/` on a long semicolon run (measured at ~8.5 s
 * for 40k `;` before this replaced the regex).
 */
export function stripTrailingSemicolons(sql: string): string {
	const s = String(sql);
	let end = s.length;
	while (end > 0) {
		const ch = s[end - 1];
		if (ch === ";" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
			end--;
		} else break;
	}
	return s.slice(0, end);
}
