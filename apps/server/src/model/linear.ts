/** Dense linear algebra and LTI helpers for small systems (a few dozen states at most). */

export type Matrix = number[][];

export function zeros(r: number, c: number): Matrix {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

export function identity(n: number): Matrix {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i]![i] = 1;
  return m;
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const r = a.length;
  const c = b[0]?.length ?? 0;
  const k = b.length;
  const out = zeros(r, c);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
    let s = 0;
    for (let x = 0; x < k; x++) s += a[i]![x]! * b[x]![j]!;
    out[i]![j] = s;
  }
  return out;
}

export function matVec(a: Matrix, v: number[]): number[] {
  return a.map((row) => row.reduce((s, x, j) => s + x * v[j]!, 0));
}

export function add(a: Matrix, b: Matrix, scaleB = 1): Matrix {
  return a.map((row, i) => row.map((x, j) => x + scaleB * b[i]![j]!));
}

export function scale(a: Matrix, s: number): Matrix {
  return a.map((row) => row.map((x) => x * s));
}

/** Solves A X = B by Gaussian elimination with partial pivoting. */
export function solve(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const m = b[0]?.length ?? 0;
  const A = a.map((r) => [...r]);
  const B = b.map((r) => [...r]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    if (Math.abs(A[piv]![col]!) < 1e-300) throw new Error("Singular matrix");
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    [B[col], B[piv]] = [B[piv]!, B[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r]![col]! / A[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r]![c]! -= f * A[col]![c]!;
      for (let c = 0; c < m; c++) B[r]![c]! -= f * B[col]![c]!;
    }
  }
  return B.map((row, i) => row.map((x) => x / A[i]![i]!));
}

/** State-space model x' = Ax + Bu (or x[k+1] = …), y = Cx + Du. */
export interface StateSpace {
  A: Matrix;
  B: Matrix;
  C: Matrix;
  D: Matrix;
}

/**
 * Transfer function (coefficients in descending powers of s or z) to controllable canonical
 * state space. Requires a proper transfer function.
 */
export function tf2ss(num: number[], den: number[]): StateSpace {
  const trim = (p: number[]) => {
    let i = 0;
    while (i < p.length - 1 && p[i] === 0) i++;
    return p.slice(i);
  };
  const d = trim(den);
  let nm = trim(num);
  if (d.length === 0 || d[0] === 0) throw new Error("Denominator must not be zero");
  if (nm.length > d.length) throw new Error("Transfer function is improper (numerator degree exceeds denominator degree)");
  const a0 = d[0]!;
  const a = d.map((x) => x / a0);
  nm = nm.map((x) => x / a0);
  const n = a.length - 1;
  const b = [...new Array<number>(a.length - nm.length).fill(0), ...nm];
  const D0 = b[0]!;
  if (n === 0) return { A: [], B: [], C: [[]], D: [[D0]] };
  // y = (b1-D0 a1) s^{n-1} … ; companion form
  const A = zeros(n, n);
  for (let j = 0; j < n; j++) A[0]![j] = -a[j + 1]!;
  for (let i = 1; i < n; i++) A[i]![i - 1] = 1;
  const B = zeros(n, 1);
  B[0]![0] = 1;
  const C = [Array.from({ length: n }, (_, j) => b[j + 1]! - D0 * a[j + 1]!)];
  return { A, B, C, D: [[D0]] };
}

/** One RK4 step of x' = Ax + Bu with u held constant over the step. */
export function rk4Step(ss: StateSpace, x: number[], u: number[], dt: number): number[] {
  const f = (xs: number[]) => {
    const ax = matVec(ss.A, xs);
    const bu = matVec(ss.B, u);
    return ax.map((v, i) => v + bu[i]!);
  };
  const k1 = f(x);
  const k2 = f(x.map((v, i) => v + (dt / 2) * k1[i]!));
  const k3 = f(x.map((v, i) => v + (dt / 2) * k2[i]!));
  const k4 = f(x.map((v, i) => v + dt * k3[i]!));
  return x.map((v, i) => v + (dt / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!));
}
