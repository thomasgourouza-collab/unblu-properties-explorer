/**
 * JavaScript-like boolean filter expressions over substring atoms:
 * && (tighter), ||, unary !, parentheses.
 * If the input contains none of `&&`, `||`, or `!`, the whole trimmed string is a single atom (parentheses are literal).
 * Special operand {@link FILTER_EXPR_NULL_KEYWORD}: matches null/empty/whitespace-only cell text (not a substring).
 * Operands may contain internal spaces; only leading/trailing whitespace per operand is trimmed.
 * Whitespace before an operator ends the operand (e.g. `a b && c d` → two atoms). Atoms are edge-trimmed only (case preserved); callers fold case when needed.
 */

/** When false, the filter is one literal search string (parentheses are not grouping). */
function filterExpressionUsesBooleanOperators(s: string): boolean {
  return s.includes('&&') || s.includes('||') || s.includes('!');
}

/** Exact operand that matches empty cell values (global / text column expression mode). */
export const FILTER_EXPR_NULL_KEYWORD = '$null' as const;

export function isFilterExprNullOperand(operand: string): boolean {
  return operand === FILTER_EXPR_NULL_KEYWORD;
}

export type FilterExprNode =
  | { type: 'atom'; value: string }
  | { type: 'not'; expr: FilterExprNode }
  | { type: 'and'; left: FilterExprNode; right: FilterExprNode }
  | { type: 'or'; left: FilterExprNode; right: FilterExprNode };

export type FilterExprParseResult =
  | { ok: true; ast: FilterExprNode }
  | { ok: false; error: string };

/** Returned when the input is empty or becomes empty after {@link sanitizeFilterExpressionInput}. */
export const FILTER_EXPR_EMPTY_ERROR = 'empty' as const;

type Token =
  | { kind: 'LPAREN' }
  | { kind: 'RPAREN' }
  | { kind: 'NOT' }
  | { kind: 'AND' }
  | { kind: 'OR' }
  | { kind: 'ATOM'; value: string }
  | { kind: 'EOF' };

function skipSpace(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) {
    j += 1;
  }
  return j;
}

/**
 * True if `j` starts `&&`, `||`, `(`, `)`, or unary `!` (after optional spaces from `j`).
 * Used to end an operand: spaces before such a token are separators, not part of the atom.
 */
function startsOperatorAfterSpaces(s: string, j: number, n: number): boolean {
  let k = j;
  while (k < n && /\s/.test(s[k])) {
    k += 1;
  }
  if (k >= n) {
    return false;
  }
  const c = s[k];
  if (c === '(' || c === ')' || c === '!') {
    return true;
  }
  if (c === '&' && k + 1 < n && s[k + 1] === '&') {
    return true;
  }
  if (c === '|' && k + 1 < n && s[k + 1] === '|') {
    return true;
  }
  return false;
}

/** Read one operand: allows internal spaces; trim edges only. Ends before next operator token. */
function readOperandToken(
  input: string,
  i: number,
  n: number
): { ok: true; end: number; value: string } | { ok: false; error: string } {
  let j = i;
  while (j < n) {
    const ch = input[j];
    if (ch === '(' || ch === ')' || ch === '!') {
      break;
    }
    if (ch === '&') {
      if (j + 1 < n && input[j + 1] === '&') {
        break;
      }
      return { ok: false, error: `Unexpected "&" inside operand at ${j} (use "&&")` };
    }
    if (ch === '|') {
      if (j + 1 < n && input[j + 1] === '|') {
        break;
      }
      return { ok: false, error: `Unexpected "|" inside operand at ${j} (use "||")` };
    }
    if (/\s/.test(ch)) {
      if (startsOperatorAfterSpaces(input, j, n)) {
        break;
      }
      j += 1;
      continue;
    }
    j += 1;
  }
  const raw = input.slice(i, j);
  const norm = trimFilterOperand(raw);
  if (!norm) {
    return { ok: false, error: `Empty operand near ${i}` };
  }
  return { ok: true, end: j, value: norm };
}

/** Drops a lone `&` or `|`; keeps only `&&` and `||` pairs. */
function removeLoneAmpersandsAndPipes(s: string): string {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === '&') {
      if (i + 1 < n && s[i + 1] === '&') {
        out += '&&';
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (s[i] === '|') {
      if (i + 1 < n && s[i + 1] === '|') {
        out += '||';
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/** Removes `(` that have no matching `)` to the right (stack-based, ignores `)` with no prior `(`). */
function removeUnmatchedOpenParens(s: string): string {
  const stack: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(') {
      stack.push(i);
    } else if (ch === ')') {
      if (stack.length > 0) {
        stack.pop();
      }
    }
  }
  if (stack.length === 0) {
    return s;
  }
  const drop = new Set(stack);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (!drop.has(i)) {
      out += s[i];
    }
  }
  return out;
}

/** Strips trailing `&&`, `||`, and unary `!` when they have no operand after (after trim). */
function stripTrailingBooleanOperators(s: string): string {
  let t = s;
  for (let guard = 0; guard < 64; guard += 1) {
    const u = t.trimEnd();
    if (u.endsWith('&&')) {
      t = u.slice(0, -2);
      continue;
    }
    if (u.endsWith('||')) {
      t = u.slice(0, -2);
      continue;
    }
    if (u.endsWith('!')) {
      t = u.slice(0, -1);
      continue;
    }
    return u;
  }
  return t.trimEnd();
}

/**
 * Drops lone `&` / `|` (not `&&` / `||`), incomplete trailing `&&` / `||` / `!`, and `(` with no closing `)`.
 * Applied in a loop until stable so e.g. `a & && b` → `a && b`, `a && (` → `a`.
 */
export function sanitizeFilterExpressionInput(raw: string): string {
  let s = raw.trim();
  if (!s) {
    return '';
  }
  for (let i = 0; i < 32; i += 1) {
    const next = stripTrailingBooleanOperators(
      removeUnmatchedOpenParens(removeLoneAmpersandsAndPipes(s))
    ).trim();
    if (next === s) {
      break;
    }
    s = next;
  }
  return s.trim();
}

/** Edge-trim only; preserves internal spaces and character case for match-case filtering. */
export function trimFilterOperand(raw: string): string {
  return raw.trim();
}

/** @deprecated Use trimFilterOperand; kept for compatibility (same as trimFilterOperand). */
export function normalizeFilterOperand(raw: string): string {
  return trimFilterOperand(raw);
}

/**
 * Tokenize `input` for expression mode. Fails on stray `|`, `&`, or empty parens.
 */
export function tokenizeFilterExpression(input: string): { ok: true; tokens: Token[] } | { ok: false; error: string } {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    i = skipSpace(input, i);
    if (i >= n) {
      break;
    }
    const c = input[i];

    if (c === '(') {
      tokens.push({ kind: 'LPAREN' });
      i += 1;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: 'RPAREN' });
      i += 1;
      continue;
    }
    if (c === '!') {
      tokens.push({ kind: 'NOT' });
      i += 1;
      continue;
    }
    if (c === '|') {
      if (i + 1 < n && input[i + 1] === '|') {
        tokens.push({ kind: 'OR' });
        i += 2;
        continue;
      }
      return { ok: false, error: `Unexpected "|" at ${i} (use "||")` };
    }
    if (c === '&') {
      if (i + 1 < n && input[i + 1] === '&') {
        tokens.push({ kind: 'AND' });
        i += 2;
        continue;
      }
      return { ok: false, error: `Unexpected "&" at ${i} (use "&&")` };
    }

    const atom = readOperandToken(input, i, n);
    if (!atom.ok) {
      return atom;
    }
    tokens.push({ kind: 'ATOM', value: atom.value });
    i = atom.end;
  }

  tokens.push({ kind: 'EOF' });
  return { ok: true, tokens };
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'EOF' };
  }

  private eat(kind: Token['kind']): boolean {
    if (this.peek().kind === kind) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parse(): FilterExprParseResult {
    try {
      const ast = this.parseOr();
      if (this.peek().kind !== 'EOF') {
        return { ok: false, error: 'Unexpected token after expression' };
      }
      return { ok: true, ast };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  private parseOr(): FilterExprNode {
    let left = this.parseAnd();
    while (this.peek().kind === 'OR') {
      this.pos += 1;
      const right = this.parseAnd();
      left = { type: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): FilterExprNode {
    let left = this.parseUnary();
    while (this.peek().kind === 'AND') {
      this.pos += 1;
      const right = this.parseUnary();
      left = { type: 'and', left, right };
    }
    return left;
  }

  private parseUnary(): FilterExprNode {
    if (this.peek().kind === 'NOT') {
      this.pos += 1;
      const inner = this.parseUnary();
      return { type: 'not', expr: inner };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FilterExprNode {
    const t = this.peek();
    if (t.kind === 'LPAREN') {
      this.pos += 1;
      const inner = this.parseOr();
      if (this.peek().kind !== 'RPAREN') {
        throw new Error('Expected ")"');
      }
      this.pos += 1;
      return inner;
    }
    if (t.kind === 'ATOM') {
      this.pos += 1;
      return { type: 'atom', value: t.value };
    }
    throw new Error(`Unexpected token: ${t.kind}`);
  }
}

export function parseFilterExpression(input: string): FilterExprParseResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: FILTER_EXPR_EMPTY_ERROR };
  }
  if (!filterExpressionUsesBooleanOperators(trimmed)) {
    return { ok: true, ast: { type: 'atom', value: trimmed } };
  }
  const sanitized = sanitizeFilterExpressionInput(input);
  if (!sanitized) {
    return { ok: false, error: FILTER_EXPR_EMPTY_ERROR };
  }
  const tok = tokenizeFilterExpression(sanitized);
  if (!tok.ok) {
    return { ok: false, error: tok.error };
  }
  return new Parser(tok.tokens).parse();
}

export function evaluateFilterAst(ast: FilterExprNode, atom: (operand: string) => boolean): boolean {
  switch (ast.type) {
    case 'atom':
      return atom(ast.value);
    case 'not':
      return !evaluateFilterAst(ast.expr, atom);
    case 'and':
      return evaluateFilterAst(ast.left, atom) && evaluateFilterAst(ast.right, atom);
    case 'or':
      return evaluateFilterAst(ast.left, atom) || evaluateFilterAst(ast.right, atom);
    default:
      return false;
  }
}

/** Operands under an even number of NOT ancestors (for positive highlights). */
export function collectHighlightOperands(ast: FilterExprNode): string[] {
  const out: string[] = [];

  const walk = (node: FilterExprNode, notParity: number): void => {
    switch (node.type) {
      case 'atom':
        if (notParity % 2 === 0) {
          out.push(node.value);
        }
        break;
      case 'not':
        walk(node.expr, notParity + 1);
        break;
      case 'and':
        walk(node.left, notParity);
        walk(node.right, notParity);
        break;
      case 'or':
        walk(node.left, notParity);
        walk(node.right, notParity);
        break;
      default:
        break;
    }
  };

  walk(ast, 0);
  return out;
}

/** One line per atom in the AST whose constraint is satisfied for this row (for match inspector). */
export function formatExpressionMatchLines(ast: FilterExprNode, atomMatches: (op: string) => boolean): string[] {
  const lines: string[] = [];

  const visit = (node: FilterExprNode, notParity: number): void => {
    switch (node.type) {
      case 'atom': {
        const m = atomMatches(node.value);
        const sat = notParity % 2 === 0 ? m : !m;
        if (sat) {
          if (isFilterExprNullOperand(node.value)) {
            lines.push(notParity % 2 === 0 ? '$null (empty)' : '!$null (has value)');
          } else {
            lines.push(
              notParity % 2 === 0 ? `${node.value} (matched)` : `!${node.value} (not present)`
            );
          }
        }
        break;
      }
      case 'not':
        visit(node.expr, notParity + 1);
        break;
      case 'and':
        visit(node.left, notParity);
        visit(node.right, notParity);
        break;
      case 'or':
        visit(node.left, notParity);
        visit(node.right, notParity);
        break;
      default:
        break;
    }
  };

  visit(ast, 0);
  return lines;
}
