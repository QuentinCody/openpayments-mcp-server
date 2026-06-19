// Low-level expression scanners for the safe search interpreter.
// Pure string/token parsing with no evaluation dependencies; extracted from
// search-tool.ts so the interpreter lives outside that file's size budget.

export function unsupportedExpression(): never {
	throw new SyntaxError("UNSUPPORTED_EXPRESSION");
}

export function readQuotedString(
	source: string,
	start: number,
): { value: string; nextPos: number } {
	const quote = source[start];
	let value = "";
	let pos = start + 1;
	let escaped = false;

	while (pos < source.length) {
		const ch = source[pos];
		if (escaped) {
			switch (ch) {
				case "n":
					value += "\n";
					break;
				case "r":
					value += "\r";
					break;
				case "t":
					value += "\t";
					break;
				case "b":
					value += "\b";
					break;
				case "f":
					value += "\f";
					break;
				case "v":
					value += "\v";
					break;
				default:
					value += ch;
			}
			escaped = false;
			pos++;
			continue;
		}

		if (ch === "\\") {
			escaped = true;
			pos++;
			continue;
		}

		if (ch === quote) {
			return {
				value,
				nextPos: pos + 1,
			};
		}

		value += ch;
		pos++;
	}

	return unsupportedExpression();
}

export function parseSpecLookupTokens(expr: string): string[] | null {
	let pos = 0;
	if (expr.startsWith("spec")) {
		pos = 4;
	} else if (expr.startsWith("SPEC")) {
		pos = 4;
	} else {
		return null;
	}

	const tokens: string[] = [];
	while (pos < expr.length) {
		while (pos < expr.length && /\s/.test(expr[pos])) pos++;
		if (pos >= expr.length) break;

		if (expr.startsWith("?.", pos) || expr.startsWith("?.[", pos)) {
			return null;
		}

		if (expr[pos] === ".") {
			pos++;
			const match = expr.slice(pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
			if (!match) return null;
			tokens.push(match[0]);
			pos += match[0].length;
			continue;
		}

		if (expr[pos] === "[") {
			pos++;
			while (pos < expr.length && /\s/.test(expr[pos])) pos++;
			if (expr[pos] !== '"' && expr[pos] !== "'") return null;
			const parsed = readQuotedString(expr, pos);
			pos = parsed.nextPos;
			while (pos < expr.length && /\s/.test(expr[pos])) pos++;
			if (expr[pos] !== "]") return null;
			tokens.push(parsed.value);
			pos++;
			continue;
		}

		return null;
	}

	return tokens;
}

export function splitTopLevelExpressions(source: string): string[] {
	const parts: string[] = [];
	let current = "";
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	let quote: string | null = null;
	let escaped = false;

	for (let pos = 0; pos < source.length; pos++) {
		const ch = source[pos];

		if (quote) {
			current += ch;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				quote = null;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "(") parenDepth++;
		if (ch === ")") parenDepth--;
		if (ch === "[") bracketDepth++;
		if (ch === "]") bracketDepth--;
		if (ch === "{") braceDepth++;
		if (ch === "}") braceDepth--;

		if (
			ch === "," &&
			parenDepth === 0 &&
			bracketDepth === 0 &&
			braceDepth === 0
		) {
			parts.push(current.trim());
			current = "";
			continue;
		}

		current += ch;
	}

	if (current.trim()) {
		parts.push(current.trim());
	}

	return parts;
}

export function parseCallExpressionAt(
	expr: string,
	start = 0,
): { callee: string; argsStr: string; nextPos: number } | null {
	let pos = start;
	while (pos < expr.length && /\s/.test(expr[pos])) pos++;

	const calleeMatch = expr
		.slice(pos)
		.match(/^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)/);
	if (!calleeMatch) return null;

	const callee = calleeMatch[1];
	pos += callee.length;
	while (pos < expr.length && /\s/.test(expr[pos])) pos++;
	if (expr[pos] !== "(") return null;

	const argsStart = pos + 1;
	pos = argsStart;
	let depth = 1;
	let quote: string | null = null;
	let escaped = false;

	for (; pos < expr.length; pos++) {
		const ch = expr[pos];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "(") {
			depth++;
			continue;
		}
		if (ch === ")") {
			depth--;
			if (depth === 0) {
				return {
					callee,
					argsStr: expr.slice(argsStart, pos),
					nextPos: pos + 1,
				};
			}
		}
	}

	return null;
}

export function stripOuterParens(expr: string): string {
	let trimmed = expr.trim();
	while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
		let depth = 0;
		let quote: string | null = null;
		let escaped = false;
		let wrapsWhole = true;

		for (let pos = 0; pos < trimmed.length; pos++) {
			const ch = trimmed[pos];
			if (quote) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					continue;
				}
				if (ch === quote) {
					quote = null;
				}
				continue;
			}

			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === "(") depth++;
			if (ch === ")") depth--;
			if (depth === 0 && pos < trimmed.length - 1) {
				wrapsWhole = false;
				break;
			}
		}

		if (!wrapsWhole) break;
		trimmed = trimmed.slice(1, -1).trim();
	}

	return trimmed;
}

export function findTopLevelArrow(expr: string): number {
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	let quote: string | null = null;
	let escaped = false;

	for (let pos = 0; pos < expr.length - 1; pos++) {
		const ch = expr[pos];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "(") parenDepth++;
		if (ch === ")") parenDepth--;
		if (ch === "[") bracketDepth++;
		if (ch === "]") bracketDepth--;
		if (ch === "{") braceDepth++;
		if (ch === "}") braceDepth--;

		if (
			expr[pos] === "=" &&
			expr[pos + 1] === ">" &&
			parenDepth === 0 &&
			bracketDepth === 0 &&
			braceDepth === 0
		) {
			return pos;
		}
	}

	return -1;
}

export function findTopLevelOperator(
	expr: string,
	operators: string[],
): { index: number; operator: string } | null {
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	let quote: string | null = null;
	let escaped = false;

	for (let pos = 0; pos < expr.length; pos++) {
		const ch = expr[pos];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "(") parenDepth++;
		if (ch === ")") parenDepth--;
		if (ch === "[") bracketDepth++;
		if (ch === "]") bracketDepth--;
		if (ch === "{") braceDepth++;
		if (ch === "}") braceDepth--;
		if (parenDepth !== 0 || bracketDepth !== 0 || braceDepth !== 0) continue;

		for (const operator of operators) {
			if (expr.startsWith(operator, pos)) {
				return { index: pos, operator };
			}
		}
	}

	return null;
}

export function findTopLevelChar(expr: string, target: string): number {
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	let quote: string | null = null;
	let escaped = false;

	for (let pos = 0; pos < expr.length; pos++) {
		const ch = expr[pos];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "(") parenDepth++;
		if (ch === ")") parenDepth--;
		if (ch === "[") bracketDepth++;
		if (ch === "]") bracketDepth--;
		if (ch === "{") braceDepth++;
		if (ch === "}") braceDepth--;
		if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && ch === target) {
			return pos;
		}
	}

	return -1;
}

export function parseMemberAccess(
	expr: string,
): { root: string; segments: Array<string | number> } | null {
	const normalized = stripOuterParens(expr);
	const rootMatch = normalized.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
	if (!rootMatch) return null;

	const segments: Array<string | number> = [];
	let pos = rootMatch[0].length;
	while (pos < normalized.length) {
		while (pos < normalized.length && /\s/.test(normalized[pos])) pos++;
		if (pos >= normalized.length) break;

		if (normalized.startsWith("?.", pos) || normalized.startsWith("?.[", pos)) {
			return null;
		}

		if (normalized[pos] === ".") {
			pos++;
			const match = normalized.slice(pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
			if (!match) return null;
			segments.push(match[0]);
			pos += match[0].length;
			continue;
		}

		if (normalized[pos] === "[") {
			pos++;
			while (pos < normalized.length && /\s/.test(normalized[pos])) pos++;
			if (normalized[pos] === '"' || normalized[pos] === "'") {
				const parsed = readQuotedString(normalized, pos);
				pos = parsed.nextPos;
				while (pos < normalized.length && /\s/.test(normalized[pos])) pos++;
				if (normalized[pos] !== "]") return null;
				segments.push(parsed.value);
				pos++;
				continue;
			}
			const closeIdx = normalized.indexOf("]", pos);
			if (closeIdx === -1) return null;
			const token = normalized.slice(pos, closeIdx).trim();
			if (!/^\d+$/.test(token)) return null;
			segments.push(Number(token));
			pos = closeIdx + 1;
			continue;
		}

		return null;
	}

	return {
		root: rootMatch[1],
		segments,
	};
}

export type ArrowParam =
	| { kind: "identifier"; name: string }
	| { kind: "array"; names: Array<string | null> };

export function parseArrowParam(source: string): ArrowParam {
	const trimmed = source.trim();
	if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) {
		return { kind: "identifier", name: trimmed };
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const names = splitTopLevelExpressions(trimmed.slice(1, -1)).map((part) => {
			const token = part.trim();
			return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token) ? token : null;
		});
		return { kind: "array", names };
	}
	return unsupportedExpression();
}

export function parseOptionalMemberAccess(
	expr: string,
	start: number,
): { key: string | number; nextPos: number; optional: boolean } | null {
	let pos = start;
	let optional = false;
	if (expr.startsWith("?.", pos)) {
		optional = true;
		pos += 2;
	} else if (expr.startsWith("?.[", pos)) {
		optional = true;
		pos += 2;
	} else if (expr[pos] === ".") {
		pos++;
	} else if (expr[pos] !== "[") {
		return null;
	}

	if (expr[pos] === "[") {
		pos++;
		while (pos < expr.length && /\s/.test(expr[pos])) pos++;
		let key: string | number;
		if (expr[pos] === '"' || expr[pos] === "'") {
			const parsed = readQuotedString(expr, pos);
			key = parsed.value;
			pos = parsed.nextPos;
		} else {
			const closeIdx = expr.indexOf("]", pos);
			if (closeIdx === -1) return null;
			const token = expr.slice(pos, closeIdx).trim();
			if (!/^\d+$/.test(token)) return null;
			key = Number(token);
			pos = closeIdx;
		}
		while (pos < expr.length && /\s/.test(expr[pos])) pos++;
		if (expr[pos] !== "]") return null;
		return {
			key,
			nextPos: pos + 1,
			optional,
		};
	}

	const identifier = expr.slice(pos).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
	if (!identifier) return null;
	return {
		key: identifier[0],
		nextPos: pos + identifier[0].length,
		optional,
	};
}
