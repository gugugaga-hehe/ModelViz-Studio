import type { BodeData, Complex, FrequencyMetrics, LoopMetrics, StepMetrics } from "@modelviz/protocol";
import { BlockError, differenceTransferFunction, formulaGain, linearModel } from "./block.ts";
import { discretize, ss2tf } from "./discretize.ts";
import { eigenvalues } from "./eigen.ts";
import { type Matrix, type StateSpace, identity, matMul, solve, tf2ss, zeros } from "./linear.ts";
import type { LoadedSystem } from "./system.ts";

export class NotLinearError extends Error {}

/** The whole System as one state-space model from its inputs (plus an optional loop break) to its outputs. */
export interface SystemModel {
  domain: "continuous" | "discrete";
  /** Sample period for discrete models. */
  T: number;
  ss: StateSpace;
  inputs: string[];
  outputs: string[];
}

const add = (a: Matrix, b: Matrix) => a.map((r, i) => r.map((x, j) => x + b[i]![j]!));

function blockModel(sys: LoadedSystem, name: string, overrides: Record<string, number>, domain: "continuous" | "discrete", T: number): StateSpace {
  const b = sys.file!.blocks[name]!;
  if (!("block" in b)) {
    if (b.kind === "sum") return { A: [], B: [], C: [], D: [[...b.signs].map((c) => (c === "-" ? -1 : 1))] };
    return { A: [], B: [], C: [], D: [[b.gain]] };
  }
  const def = sys.defs.get(name)!;
  const params = { ...b.parameters, ...overrides };
  const f = def.file;
  let ss: StateSpace;
  let blockDomain: "continuous" | "discrete" | "memoryless";
  try {
    if (f.kind === "transfer-function" || f.kind === "state-space") {
      const lm = linearModel(def, params)!;
      ss = lm.ss;
      blockDomain = lm.domain;
    } else if (f.kind === "difference-equation") {
      if (!f.linear) throw new NotLinearError(`${name} (${def.path}) is not declared linear`);
      const { num, den } = differenceTransferFunction(def, params);
      ss = tf2ss(num, den);
      blockDomain = "discrete";
    } else {
      if (!f.linear) throw new NotLinearError(`${name} (${def.path}) is not declared linear`);
      ss = { A: [], B: [], C: [], D: formulaGain(def, params) };
      blockDomain = "memoryless";
    }
  } catch (e) {
    if (e instanceof NotLinearError) throw e;
    throw new NotLinearError(`${name}: ${(e as BlockError).message}`);
  }
  if (blockDomain === "continuous" && domain === "discrete") return discretize(ss, T, "zoh");
  return ss;
}

/**
 * Interconnects the Blocks: with block outputs y, inputs u = M y + N r,
 *   y = (I − D M)⁻¹ (C x + D N r)   (invertible because there is no algebraic loop)
 * which yields a single model. `breakAt` cuts the Connection into that input Port, turning
 * it into an extra input `__loop_in` and exposing its original driver as output `__loop_out`.
 */
export function systemModel(sys: LoadedSystem, overrides: Record<string, Record<string, number>>, breakAt?: string): SystemModel {
  const file = sys.file!;
  const names = Object.keys(file.blocks);
  const discreteBlocks = [...sys.defs.values()].some((d) => d.domain === "discrete");
  const domain = discreteBlocks ? "discrete" : "continuous";
  const T = 1 / file.sampleRateHz;
  const models = names.map((n) => blockModel(sys, n, overrides[n] ?? {}, domain, T));
  const defsPorts = names.map((n) => {
    const b = file.blocks[n]!;
    if ("block" in b) {
      const d = sys.defs.get(n)!;
      return { inputs: d.inputs, outputs: d.outputs };
    }
    if (b.kind === "sum") return { inputs: [...b.signs].map((_, i) => `in${i + 1}`), outputs: ["out"] };
    return { inputs: ["u"], outputs: ["y"] };
  });

  // global indices
  const xOff: number[] = [];
  const uIdx = new Map<string, number>();
  const yIdx = new Map<string, number>();
  let nx = 0;
  names.forEach((n, i) => {
    xOff.push(nx);
    nx += models[i]!.A.length;
    for (const p of defsPorts[i]!.inputs) uIdx.set(`${n}.${p}`, uIdx.size);
    for (const p of defsPorts[i]!.outputs) yIdx.set(`${n}.${p}`, yIdx.size);
  });
  const nu = uIdx.size;
  const ny = yIdx.size;
  const inputs = [...file.inputs];
  if (breakAt) {
    if (!uIdx.has(breakAt)) throw new NotLinearError(`openLoopAt: ${breakAt} is not an input Port of the System`);
    inputs.push("__loop_in");
  }
  const nr = inputs.length;

  const A = zeros(nx, nx);
  const B = zeros(nx, nu);
  const C = zeros(ny, nx);
  const D = zeros(ny, nu);
  names.forEach((n, i) => {
    const m = models[i]!;
    const ports = defsPorts[i]!;
    const xs = xOff[i]!;
    const us = ports.inputs.map((p) => uIdx.get(`${n}.${p}`)!);
    const ys = ports.outputs.map((p) => yIdx.get(`${n}.${p}`)!);
    m.A.forEach((row, r) => row.forEach((v, c) => (A[xs + r]![xs + c] = v)));
    m.B.forEach((row, r) => row.forEach((v, c) => (B[xs + r]![us[c]!] = v)));
    m.C.forEach((row, r) => row.forEach((v, c) => (C[ys[r]!]![xs + c] = v)));
    m.D.forEach((row, r) => row.forEach((v, c) => (D[ys[r]!]![us[c]!] = v)));
  });

  const M = zeros(nu, ny);
  const N = zeros(nu, nr);
  let loopSource: string | null = null;
  for (const c of file.connections) {
    const u = uIdx.get(c.to)!;
    if (c.to === breakAt) {
      loopSource = c.from;
      N[u]![nr - 1] = 1;
      continue;
    }
    if (c.from.includes(".")) M[u]![yIdx.get(c.from)!] = 1;
    else N[u]![inputs.indexOf(c.from)] = 1;
  }
  const outputs = Object.keys(file.outputs);
  const sources = Object.values(file.outputs);
  if (breakAt) {
    outputs.push("__loop_out");
    sources.push(loopSource!);
  }
  const S = zeros(outputs.length, ny);
  const Tm = zeros(outputs.length, nr);
  sources.forEach((src, o) => {
    if (src.includes(".")) S[o]![yIdx.get(src)!] = 1;
    else Tm[o]![inputs.indexOf(src)] = 1;
  });

  const L = solve(add(identity(ny), matMul(D, M).map((r) => r.map((x) => -x))), identity(ny));
  const LC = matMul(L, C);
  const LDN = matMul(L, matMul(D, N));
  const BM = matMul(B, M);
  return {
    domain,
    T,
    inputs,
    outputs,
    ss: {
      A: add(A, matMul(BM, LC)),
      B: add(matMul(BM, LDN), matMul(B, N)),
      C: matMul(S, LC),
      D: add(matMul(S, LDN), Tm),
    },
  };
}

// ---- complex helpers --------------------------------------------------------

type C = [number, number];

/** Solves (pI − A) X = B for complex scalar p, returning C X + D for one input column. */
export function responseAt(model: SystemModel, input: number, p: C): C[] {
  const { A, B, C: Cm, D } = model.ss;
  const n = A.length;
  // complex Gaussian elimination on [pI − A | b]
  const re = A.map((row, i) => row.map((v, j) => (i === j ? p[0] : 0) - v));
  const im = A.map((row, i) => row.map((_, j) => (i === j ? p[1] : 0)));
  const br = B.map((row) => row[input]!);
  const bi = B.map(() => 0);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.hypot(re[r]![col]!, im[r]![col]!) > Math.hypot(re[piv]![col]!, im[piv]![col]!)) piv = r;
    [re[col], re[piv]] = [re[piv]!, re[col]!];
    [im[col], im[piv]] = [im[piv]!, im[col]!];
    [br[col], br[piv]] = [br[piv]!, br[col]!];
    [bi[col], bi[piv]] = [bi[piv]!, bi[col]!];
    const pr = re[col]![col]!;
    const pi = im[col]![col]!;
    const den = pr * pr + pi * pi;
    if (den === 0) return Cm.map(() => [Number.POSITIVE_INFINITY, 0] as C);
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      // f = a[r][col] / a[col][col]
      const ar = re[r]![col]!;
      const ai = im[r]![col]!;
      if (ar === 0 && ai === 0) continue;
      const fr = (ar * pr + ai * pi) / den;
      const fi = (ai * pr - ar * pi) / den;
      for (let c = col; c < n; c++) {
        const xr = re[col]![c]!;
        const xi = im[col]![c]!;
        re[r]![c]! -= fr * xr - fi * xi;
        im[r]![c]! -= fr * xi + fi * xr;
      }
      const yr = br[col]!;
      const yi = bi[col]!;
      br[r]! -= fr * yr - fi * yi;
      bi[r]! -= fr * yi + fi * yr;
    }
  }
  const xr = br.map((v, i) => {
    const pr = re[i]![i]!;
    const pi = im[i]![i]!;
    return (v * pr + bi[i]! * pi) / (pr * pr + pi * pi);
  });
  const xi = br.map((v, i) => {
    const pr = re[i]![i]!;
    const pi = im[i]![i]!;
    return (bi[i]! * pr - v * pi) / (pr * pr + pi * pi);
  });
  return Cm.map((row, o) => {
    let r = D[o]![input]!;
    let i = 0;
    row.forEach((cv, j) => {
      r += cv * xr[j]!;
      i += cv * xi[j]!;
    });
    return [r, i] as C;
  });
}

/** The point where H is evaluated for frequency f: jω, or e^{jωT}. */
export function evalPoint(model: SystemModel, fHz: number): C {
  const w = 2 * Math.PI * fHz;
  return model.domain === "continuous" ? [0, w] : [Math.cos(w * model.T), Math.sin(w * model.T)];
}

export function dcPoint(model: SystemModel): C {
  return model.domain === "continuous" ? [0, 0] : [1, 0];
}

export function logspace(f0: number, f1: number, n: number): number[] {
  const a = Math.log10(f0);
  const b = Math.log10(f1);
  return Array.from({ length: n }, (_, i) => 10 ** (a + ((b - a) * i) / (n - 1)));
}

const db = (h: C) => 20 * Math.log10(Math.hypot(h[0], h[1]));

export function bode(values: C[]): BodeData {
  const mag = values.map(db);
  const phase: number[] = [];
  let offset = 0;
  values.forEach((h, i) => {
    let ph = (Math.atan2(h[1], h[0]) * 180) / Math.PI + offset;
    if (i > 0) {
      while (ph - phase[i - 1]! > 180) {
        ph -= 360;
        offset -= 360;
      }
      while (ph - phase[i - 1]! < -180) {
        ph += 360;
        offset += 360;
      }
    }
    phase.push(ph);
  });
  return { magnitudeDb: mag, phaseDeg: phase };
}

/** Refines a sign change of g(f) between f0 and f1 (log-frequency bisection). */
function bisect(g: (f: number) => number, f0: number, f1: number): number {
  let a = Math.log(f0);
  let b = Math.log(f1);
  const ga = g(f0);
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    if (Math.sign(g(Math.exp(m))) === Math.sign(ga)) a = m;
    else b = m;
  }
  return Math.exp((a + b) / 2);
}

export function frequencyMetrics(model: SystemModel, input: number, output: number, freqs: number[], data: BodeData): FrequencyMetrics {
  const dc = responseAt(model, input, dcPoint(model))[output]!;
  const dcDb = Number.isFinite(dc[0]) && Math.hypot(...dc) > 1e-15 ? db(dc) : null;
  let peakI = 0;
  data.magnitudeDb.forEach((m, i) => {
    if (m > data.magnitudeDb[peakI]!) peakI = i;
  });
  let bandwidthHz: number | null = null;
  if (dcDb !== null) {
    // half-power point: |H| = |H(0)|/√2
    const level = dcDb - 10 * Math.log10(2);
    const g = (f: number) => db(responseAt(model, input, evalPoint(model, f))[output]!) - level;
    for (let i = 1; i < freqs.length; i++) {
      if (data.magnitudeDb[i - 1]! - level >= 0 && data.magnitudeDb[i]! - level < 0) {
        bandwidthHz = bisect(g, freqs[i - 1]!, freqs[i]!);
        break;
      }
    }
  }
  return { dcGainDb: dcDb, bandwidthHz, peakGainDb: data.magnitudeDb[peakI]!, peakHz: freqs[peakI]! };
}

/** Gain and phase margins of a loop transfer L (negative feedback). */
export function loopMetrics(model: SystemModel, input: number, output: number, freqs: number[], data: BodeData): LoopMetrics {
  const L = (f: number): C => {
    const h = responseAt(model, input, evalPoint(model, f))[output]!;
    return [-h[0], -h[1]];
  };
  let gainCrossoverHz: number | null = null;
  let phaseMarginDeg: number | null = null;
  for (let i = 1; i < freqs.length; i++) {
    if (data.magnitudeDb[i - 1]! >= 0 && data.magnitudeDb[i]! < 0) {
      gainCrossoverHz = bisect((f) => db(L(f)), freqs[i - 1]!, freqs[i]!);
      // phase at crossover on the same unwrapped branch as the grid
      const ph = data.phaseDeg[i]! + angleDiff(L(gainCrossoverHz), L(freqs[i]!));
      phaseMarginDeg = 180 + ph;
      break;
    }
  }
  let phaseCrossoverHz: number | null = null;
  let gainMarginDb: number | null = null;
  for (let i = 1; i < freqs.length; i++) {
    const a = data.phaseDeg[i - 1]!;
    const b = data.phaseDeg[i]!;
    const k = Math.floor((a + 180) / 360);
    const level = -180 + 360 * k;
    if ((a - level) * (b - level) <= 0 && a !== b) {
      const base = data.phaseDeg[i - 1]!;
      const ref = L(freqs[i - 1]!);
      phaseCrossoverHz = bisect((f) => base + angleDiff(L(f), ref) - level, freqs[i - 1]!, freqs[i]!);
      gainMarginDb = -db(L(phaseCrossoverHz));
      break;
    }
  }
  return { gainMarginDb, phaseCrossoverHz, phaseMarginDeg, gainCrossoverHz };
}

/** Angle of a relative to b in degrees, in (−180, 180]. */
function angleDiff(a: C, b: C): number {
  const d = ((Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])) * 180) / Math.PI;
  return ((d + 540) % 360) - 180;
}

export function poles(model: SystemModel): Complex[] {
  return eigenvalues(model.ss.A);
}

/** Zeros of the SISO transfer input → output (roots of its numerator). */
export function zerosOf(model: SystemModel, input: number, output: number): Complex[] {
  const siso: StateSpace = {
    A: model.ss.A,
    B: model.ss.B.map((r) => [r[input]!]),
    C: [model.ss.C[output]!],
    D: [[model.ss.D[output]![input]!]],
  };
  const { num } = ss2tf(siso);
  const scaleRef = Math.max(...num.map(Math.abs));
  let i = 0;
  while (i < num.length && Math.abs(num[i]!) <= 1e-12 * scaleRef) i++;
  const p = num.slice(i);
  if (p.length <= 1) return [];
  const lead = p[0]!;
  const n = p.length - 1;
  const companion = zeros(n, n);
  for (let j = 0; j < n; j++) companion[0]![j] = -p[j + 1]! / lead;
  for (let r = 1; r < n; r++) companion[r]![r - 1] = 1;
  return eigenvalues(companion);
}

export function isStable(model: SystemModel, ps: Complex[]): boolean {
  return model.domain === "continuous" ? ps.every((p) => p.re < 0) : ps.every((p) => Math.hypot(p.re, p.im) < 1);
}

/**
 * Step-response Metrics relative to the final value. Pass `finalValue` when it is known
 * analytically (DC gain of a stable linear System); otherwise the last sample is used.
 */
export function stepMetrics(times: number[], y: number[], finalValue?: number): StepMetrics {
  const final = finalValue ?? y.at(-1) ?? 0;
  let peak = 0;
  y.forEach((v, i) => {
    if ((final >= 0 ? v > y[peak]! : v < y[peak]!)) peak = i;
  });
  const overshoot = final !== 0 ? Math.max(0, ((y[peak]! - final) / Math.abs(final)) * 100) : 0;
  const cross = (level: number): number | null => {
    for (let i = 1; i < y.length; i++) {
      const a = (y[i - 1]! - level) * Math.sign(final || 1);
      const b = (y[i]! - level) * Math.sign(final || 1);
      if (a < 0 && b >= 0) return times[i - 1]! + ((times[i]! - times[i - 1]!) * -a) / (b - a);
    }
    return null;
  };
  const t10 = cross(0.1 * final);
  const t90 = cross(0.9 * final);
  let settling: number | null = null;
  const band = 0.02 * Math.abs(final);
  if (final !== 0) {
    let last = -1;
    y.forEach((v, i) => {
      if (Math.abs(v - final) > band) last = i;
    });
    // Only call it settled if the response then stays in the band for the last 10 % of the run.
    settling = last < 0 ? 0 : last + 1 < times.length * 0.9 ? times[last + 1]! : null;
  }
  return {
    finalValue: final,
    overshootPercent: overshoot,
    riseTimeS: t10 !== null && t90 !== null ? t90 - t10 : null,
    settlingTimeS: settling,
    peakTimeS: times[peak]!,
  };
}

/**
 * Exact step-response final value per output of a linear System, or null when it does not
 * exist (unstable) or the System is not linear.
 */
export function linearFinalValues(sys: LoadedSystem, overrides: Record<string, Record<string, number>>, input: string): Record<string, number | null> | null {
  let model: SystemModel;
  try {
    model = systemModel(sys, overrides);
  } catch {
    return null;
  }
  const inp = model.inputs.indexOf(input);
  if (inp < 0) return null;
  const stable = isStable(model, poles(model));
  const dc = responseAt(model, inp, dcPoint(model));
  return Object.fromEntries(model.outputs.map((o, i) => [o, stable && Number.isFinite(dc[i]![0]) ? dc[i]![0] : null]));
}
