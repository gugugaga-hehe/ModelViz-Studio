import type { BodeData, FrequencyMetrics, LoopMetrics, SystemFile } from "@modelviz/protocol";
import { ProtocolFailure } from "../errors.ts";
import { bode } from "./lti.ts";
import type { PythonHost } from "./python-host.ts";
import { type LoadedSystem, SystemEngine } from "./system.ts";

/** Purely continuous Systems are simulated this much faster, so the hold adds no visible phase lag. */
const OVERSAMPLE = 20;
const SETTLE_CYCLES = 3;
const MIN_SETTLE_S = 0.5;
const MEASURE_CYCLES = 5;
const CHUNK = 20000;

export interface MeasureControl {
  cancelled: boolean;
  progress(done: number, total: number): void;
}

/** A copy of the System with the Connection into `port` cut: `__loop_in` drives it, `__loop_out` is the old driver. */
export function breakLoop(sys: LoadedSystem, port: string): LoadedSystem {
  const file = sys.file!;
  const conn = file.connections.find((c) => c.to === port);
  if (!conn) throw new ProtocolFailure("invalid_params", `openLoopAt: ${port} is not a connected input Port`);
  const broken: SystemFile = {
    ...file,
    inputs: [...file.inputs, "__loop_in"],
    connections: file.connections.map((c) => (c.to === port ? { from: "__loop_in", to: port } : c)),
    outputs: { ...file.outputs, __loop_out: conn.from },
  };
  return { ...sys, file: broken };
}

function withRate(sys: LoadedSystem, fs: number): LoadedSystem {
  return { ...sys, file: { ...sys.file!, sampleRateHz: fs } };
}

/**
 * Stepped-sine measurement: for each frequency, drive `input` with a sine from rest, let the
 * transient settle, then estimate H(f) = Y(f)/U(f) by single-bin DFT over whole cycles.
 * For nonlinear Systems this is the describing-function response at the given amplitude.
 */
export async function measureResponses(
  sys: LoadedSystem,
  input: string,
  freqs: number[],
  amplitude: number,
  overrides: Record<string, Record<string, number>>,
  host: PythonHost | null,
  ctl: MeasureControl,
): Promise<{ domain: "continuous" | "discrete"; values: Record<string, [number, number][]> }> {
  const continuousOnly = [...sys.defs.values()].every((d) => d.domain === "continuous" || d.domain === "memoryless");
  const factor = continuousOnly ? OVERSAMPLE : 1;
  const fs = sys.file!.sampleRateHz * factor;
  const run = withRate(sys, fs);
  const outputs = Object.keys(run.file!.outputs);
  const values: Record<string, [number, number][]> = Object.fromEntries(outputs.map((o) => [o, []]));

  for (let fi = 0; fi < freqs.length; fi++) {
    if (ctl.cancelled) throw new ProtocolFailure("cancelled", "Frequency Response measurement cancelled");
    const f = freqs[fi]!;
    const engine = new SystemEngine(run, overrides, host ? { python: host } : {});
    const settle = Math.ceil(Math.max(SETTLE_CYCLES / f, MIN_SETTLE_S) * fs);
    const cycles = Math.max(MEASURE_CYCLES, Math.ceil(0.2 * f));
    const measure = Math.max(4, Math.round((cycles * fs) / f));
    const total = settle + measure;
    const w = 2 * Math.PI * f;
    // Least-squares fit of a·cos + b·sin + d over the measurement window: exact even when the
    // window does not hold a whole number of cycles (unlike a single-bin DFT).
    const M = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const rhs = [...outputs, "__u"].map(() => [0, 0, 0]);
    for (let start = 0; start < total; start += CHUNK) {
      const n = Math.min(CHUNK, total - start);
      const out = await engine.run(n, (name, _k, t) => (name === input ? amplitude * Math.sin(w * t) : 0));
      for (let i = 0; i < n; i++) {
        const k = start + i;
        if (k < settle) continue;
        const t = k / fs;
        const basis = [Math.cos(w * t), Math.sin(w * t), 1];
        for (let r = 0; r < 3; r++) for (let c2 = 0; c2 < 3; c2++) M[r]![c2]! += basis[r]! * basis[c2]!;
        const sig = [...out.map((y) => y[i]!), amplitude * basis[1]!];
        sig.forEach((v, j) => {
          for (let r = 0; r < 3; r++) rhs[j]![r]! += basis[r]! * v;
        });
      }
      if (ctl.cancelled) throw new ProtocolFailure("cancelled", "Frequency Response measurement cancelled");
      await new Promise<void>((r) => setImmediate(r));
    }
    const fit = rhs.map((b) => solve3(M, b));
    // phasor of a·cos + b·sin is a − j·b
    const [ur, ui] = [fit.at(-1)![0]!, -fit.at(-1)![1]!];
    const den = ur * ur + ui * ui;
    outputs.forEach((o, i) => {
      const [yr, yi] = [fit[i]![0]!, -fit[i]![1]!];
      values[o]!.push([(yr * ur + yi * ui) / den, (yi * ur - yr * ui) / den]);
    });
    ctl.progress(fi + 1, freqs.length);
  }
  return { domain: continuousOnly ? "continuous" : "discrete", values };
}

function solve3(A: number[][], b: number[]): number[] {
  const m = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return [0, 1, 2].map((i) => m[i]![3]! / m[i]![i]!);
}

/** Interpolated crossing of `values` through `level` between grid points (log frequency). */
function crossing(freqs: number[], values: number[], level: number, from = 0): number | null {
  for (let i = Math.max(1, from); i < freqs.length; i++) {
    const a = values[i - 1]! - level;
    const b = values[i]! - level;
    if (a === 0) return freqs[i - 1]!;
    if (a * b < 0) {
      const x = a / (a - b);
      return Math.exp(Math.log(freqs[i - 1]!) + x * (Math.log(freqs[i]!) - Math.log(freqs[i - 1]!)));
    }
  }
  return null;
}

function interp(freqs: number[], values: number[], f: number): number {
  for (let i = 1; i < freqs.length; i++) {
    if (f <= freqs[i]!) {
      const x = (Math.log(f) - Math.log(freqs[i - 1]!)) / (Math.log(freqs[i]!) - Math.log(freqs[i - 1]!));
      return values[i - 1]! + x * (values[i]! - values[i - 1]!);
    }
  }
  return values.at(-1)!;
}

/** Frequency Metrics from a measured grid; the DC gain is taken at the lowest measured frequency. */
export function gridMetrics(freqs: number[], data: BodeData): FrequencyMetrics {
  const dc = data.magnitudeDb[0]!;
  let peak = 0;
  data.magnitudeDb.forEach((m, i) => {
    if (m > data.magnitudeDb[peak]!) peak = i;
  });
  return {
    dcGainDb: dc,
    bandwidthHz: crossing(freqs, data.magnitudeDb, dc - 10 * Math.log10(2)),
    peakGainDb: data.magnitudeDb[peak]!,
    peakHz: freqs[peak]!,
  };
}

export function gridLoopMetrics(freqs: number[], data: BodeData): LoopMetrics {
  const gc = crossing(freqs, data.magnitudeDb, 0);
  const pmPhase = gc === null ? null : interp(freqs, data.phaseDeg, gc);
  // phase crossover on the −180° (mod 360) branch the curve first reaches
  let pc: number | null = null;
  for (let i = 1; i < freqs.length && pc === null; i++) {
    const level = -180 + 360 * Math.floor((data.phaseDeg[i - 1]! + 180) / 360);
    pc = crossing(freqs.slice(i - 1, i + 1), data.phaseDeg.slice(i - 1, i + 1), level);
  }
  return {
    gainCrossoverHz: gc,
    phaseMarginDeg: pmPhase === null ? null : 180 + pmPhase,
    phaseCrossoverHz: pc,
    gainMarginDb: pc === null ? null : -interp(freqs, data.magnitudeDb, pc),
  };
}

export function toBode(values: [number, number][]): BodeData {
  return bode(values);
}
