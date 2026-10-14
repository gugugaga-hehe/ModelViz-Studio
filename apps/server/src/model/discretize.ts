import { type Matrix, type StateSpace, add, identity, matMul, scale, solve, zeros } from "./linear.ts";

export type DiscretizationMethod = "zoh" | "tustin";

function norm1(a: Matrix): number {
  let m = 0;
  for (let j = 0; j < (a[0]?.length ?? 0); j++) m = Math.max(m, a.reduce((s, r) => s + Math.abs(r[j]!), 0));
  return m;
}

/** Matrix exponential by scaling and squaring with a degree-6 Padé approximant. */
export function expm(a: Matrix): Matrix {
  const n = a.length;
  if (n === 0) return [];
  const s = Math.max(0, Math.ceil(Math.log2(norm1(a) / 0.5)));
  const A = scale(a, 1 / 2 ** s);
  const c = [1, 1 / 2, 5 / 44, 1 / 66, 1 / 792, 1 / 15840, 1 / 665280];
  let X = identity(n);
  let N = identity(n);
  let D = identity(n);
  for (let k = 1; k < c.length; k++) {
    X = matMul(A, X);
    N = add(N, X, c[k]!);
    D = add(D, X, (k % 2 ? -1 : 1) * c[k]!);
  }
  let E = solve(D, N);
  for (let k = 0; k < s; k++) E = matMul(E, E);
  return E;
}

/**
 * Converts a continuous state-space model to discrete time at sample period T.
 * - `zoh`: exact for inputs held constant between samples.
 * - `tustin`: bilinear transform; with `prewarpHz` the frequency response matches exactly there.
 */
export function discretize(ss: StateSpace, T: number, method: DiscretizationMethod, prewarpHz?: number): StateSpace {
  const n = ss.A.length;
  const m = ss.B[0]?.length ?? ss.D[0]?.length ?? 1;
  if (n === 0) return { A: [], B: [], C: ss.C, D: ss.D };
  if (method === "zoh") {
    // exp([[A, B], [0, 0]] T) = [[Ad, Bd], [0, I]]
    const M = zeros(n + m, n + m);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i]![j] = ss.A[i]![j]! * T;
      for (let j = 0; j < m; j++) M[i]![n + j] = ss.B[i]![j]! * T;
    }
    const E = expm(M);
    return {
      A: E.slice(0, n).map((r) => r.slice(0, n)),
      B: E.slice(0, n).map((r) => r.slice(n, n + m)),
      C: ss.C,
      D: ss.D,
    };
  }
  // Tustin: s = (2/Te)(z−1)/(z+1); prewarping replaces T by Te = 2·tan(ω T/2)/ω.
  const w = prewarpHz ? 2 * Math.PI * prewarpHz : 0;
  const Te = w ? (2 * Math.tan((w * T) / 2)) / w : T;
  const I = identity(n);
  const Mm = add(I, ss.A, -Te / 2); // I − A Te/2
  const Mp = add(I, ss.A, Te / 2); // I + A Te/2
  const inv = solve(Mm, I);
  const Ad = matMul(inv, Mp);
  const Bd = scale(matMul(inv, ss.B), Te);
  const Cd = matMul(ss.C, inv);
  const Dd = add(ss.D, matMul(matMul(ss.C, inv), ss.B), Te / 2);
  return { A: Ad, B: Bd, C: Cd, D: Dd };
}

/**
 * SISO state space to transfer function (descending powers), via Faddeev–LeVerrier:
 * det(zI − A) = Σ c_k z^{n−k}, adj(zI − A) = Σ M_k z^{n−1−k}.
 */
export function ss2tf(ss: StateSpace): { num: number[]; den: number[] } {
  const n = ss.A.length;
  const d = ss.D[0]?.[0] ?? 0;
  if (n === 0) return { num: [d], den: [1] };
  const den = [1];
  const Ms: Matrix[] = [];
  let M = identity(n);
  for (let k = 1; k <= n; k++) {
    Ms.push(M);
    const AM = matMul(ss.A, M);
    const ck = -AM.reduce((s, r, i) => s + r[i]!, 0) / k;
    den.push(ck);
    M = add(AM, identity(n), ck);
  }
  // num = C adj(zI−A) B + D det(zI−A)
  const num = new Array<number>(n + 1).fill(0);
  num[0] = d;
  for (let k = 0; k < n; k++) {
    const cmb = matMul(matMul(ss.C, Ms[k]!), ss.B)[0]![0]!;
    num[k + 1] = cmb + d * den[k + 1]!;
  }
  // tidy round-off
  const clean = (x: number) => (Math.abs(x) < 1e-14 * Math.max(1, ...num.map(Math.abs), ...den.map(Math.abs)) ? 0 : x);
  return { num: num.map(clean), den: den.map(clean) };
}
