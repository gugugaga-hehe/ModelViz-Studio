/**
 * Small arithmetic expression language for Block definitions:
 *   numbers, identifiers, + - * / ^ (right-assoc), unary ±, parentheses,
 *   functions (sin cos tan asin acos atan atan2 exp log log10 sqrt abs min max floor ceil
 *   round sign tanh sat), constants pi and e, and comparisons/ternary for switching logic
 *   (a > b ? x : y).
 * Expressions compile to closures over a numeric scope.
 */

export class ExprError extends Error {}

type Scope = Record<string, number>;
export type Compiled = (scope: Scope) => number;

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  tanh: Math.tanh,
  /** sat(x, lo, hi): clamp */
  sat: (x, lo, hi) => Math.min(hi!, Math.max(lo!, x!)),
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(<=|>=|==|!=|&&|\|\||[-+*/^(),?:<>!])/.exec(src.slice(i));
    if (op) {
      out.push({ t: "op", v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}" in "${src}"`);
  }
  return out;
}

/** Compiles an expression; `vars` collects identifiers it reads. */
export function compile(src: string | number, vars?: Set<string>): Compiled {
  if (typeof src === "number") return () => src;
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected "${v}" in "${src}"`);
    pos++;
  };

  // precedence climbing
  const ternary = (): Compiled => {
    const cond = or();
    if (!isOp("?")) return cond;
    pos++;
    const a = ternary();
    expect(":");
    const b = ternary();
    return (s) => (cond(s) ? a(s) : b(s));
  };
  const binary = (next: () => Compiled, ops: Record<string, (a: number, b: number) => number>) => (): Compiled => {
    let left = next();
    while (peek()?.t === "op" && peek()!.v in ops) {
      const f = ops[(toks[pos++] as { v: string }).v]!;
      const l = left;
      const r = next();
      left = (s) => f(l(s), r(s));
    }
    return left;
  };
  const unary = (): Compiled => {
    if (isOp("-")) {
      pos++;
      const a = unary();
      return (s) => -a(s);
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    if (isOp("!")) {
      pos++;
      const a = unary();
      return (s) => (a(s) ? 0 : 1);
    }
    return power();
  };
  const power = (): Compiled => {
    const base = primary();
    if (!isOp("^")) return base;
    pos++;
    const exp = unary();
    return (s) => base(s) ** exp(s);
  };
  const primary = (): Compiled => {
    const tok = toks[pos++];
    if (!tok) throw new ExprError(`Unexpected end of "${src}"`);
    if (tok.t === "num") return () => tok.v;
    if (tok.t === "op" && tok.v === "(") {
      const e = ternary();
      expect(")");
      return e;
    }
    if (tok.t === "id") {
      if (isOp("(")) {
        const fn = FUNCTIONS[tok.v];
        if (!fn) throw new ExprError(`Unknown function ${tok.v}() in "${src}"`);
        pos++;
        const args: Compiled[] = [];
        if (!isOp(")")) {
          args.push(ternary());
          while (isOp(",")) {
            pos++;
            args.push(ternary());
          }
        }
        expect(")");
        return (s) => fn(...args.map((a) => a(s)));
      }
      if (tok.v in CONSTANTS) {
        const v = CONSTANTS[tok.v]!;
        return () => v;
      }
      vars?.add(tok.v);
      const name = tok.v;
      return (s) => {
        const v = s[name];
        if (v === undefined) throw new ExprError(`Unknown name "${name}"`);
        return v;
      };
    }
    throw new ExprError(`Unexpected "${tok.v}" in "${src}"`);
  };
  const mul = binary(unary, { "*": (a, b) => a * b, "/": (a, b) => a / b });
  const add = binary(mul, { "+": (a, b) => a + b, "-": (a, b) => a - b });
  const cmp = binary(add, {
    "<": (a, b) => +(a < b),
    ">": (a, b) => +(a > b),
    "<=": (a, b) => +(a <= b),
    ">=": (a, b) => +(a >= b),
    "==": (a, b) => +(a === b),
    "!=": (a, b) => +(a !== b),
  });
  const and = binary(cmp, { "&&": (a, b) => +(a !== 0 && b !== 0) });
  const or = binary(and, { "||": (a, b) => +(a !== 0 || b !== 0) });

  const result = ternary();
  if (pos !== toks.length) throw new ExprError(`Unexpected "${(toks[pos] as { v: unknown }).v}" in "${src}"`);
  return result;
}

/** Evaluates a constant expression over Block Parameters. */
export function evaluate(src: string | number, scope: Scope): number {
  const v = compile(src)(scope);
  if (!Number.isFinite(v)) throw new ExprError(`"${src}" does not evaluate to a finite number`);
  return v;
}
