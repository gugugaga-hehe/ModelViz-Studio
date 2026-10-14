import { MAX_TIME_SAMPLES, type StepMetrics, type TimeAnalysisRequest, type TimeAnalysisResult } from "@modelviz/protocol";
import { ProtocolFailure } from "../errors.ts";
import { linearFinalValues, stepMetrics } from "./lti.ts";
import { stimulusFn } from "./stimulus.ts";
import { PythonHost, type PythonRuntime } from "./python-host.ts";
import { type LoadedSystem, SystemEngine, SystemError, loadSystem } from "./system.ts";

/** Samples simulated per engine.run call of a long run. */
const CHUNK = 1000;
/** Longest stretch of simulation before yielding to the event loop (ms), so live I/O keeps flowing. */
const SLICE_MS = 15;

/** Cancellation and progress of a long-running Analysis. */
export interface AnalysisControl {
  cancelled: boolean;
  progress(done: number, total: number): void;
  /** Aborted on cancellation, to stop work that cannot poll `cancelled` (e.g. a Python host). */
  signal?: AbortSignal;
}

/** Fails when a run of `count` samples would exceed MAX_TIME_SAMPLES. */
export function checkSampleBudget(count: number, fs: number, durationS: number): void {
  if (count > MAX_TIME_SAMPLES) {
    throw new ProtocolFailure(
      "invalid_params",
      `${durationS} s at ${fs} Hz is ${count} samples; at most ${MAX_TIME_SAMPLES} fit in one run (shorten the duration to ${Math.floor((MAX_TIME_SAMPLES - 1) / fs)} s)`,
    );
  }
}

/**
 * engine.run in chunks, yielding to the event loop between them, so a long simulation never
 * blocks Sources, Recordings or other requests. Returns one array per System output.
 */
export async function runChunked(
  engine: SystemEngine,
  count: number,
  input: (name: string, k: number, t: number) => number,
  ctl?: AnalysisControl,
): Promise<Float64Array[]> {
  const out = engine.outputs.map(() => new Float64Array(count));
  let sliceStart = performance.now();
  for (let start = 0; start < count; start += CHUNK) {
    if (ctl?.cancelled) throw new ProtocolFailure("cancelled", "Analysis cancelled");
    const part = await engine.run(Math.min(CHUNK, count - start), input);
    part.forEach((p, i) => out[i]!.set(p, start));
    if (performance.now() - sliceStart > SLICE_MS && start + CHUNK < count) {
      ctl?.progress(start + CHUNK, count);
      await new Promise<void>((r) => setImmediate(r));
      sliceStart = performance.now();
    }
  }
  ctl?.progress(count, count);
  return out;
}

/** A recorded Signal: times in seconds from its first sample. */
export interface SampledSignal {
  t: Float64Array;
  v: Float64Array;
}

/** Value of a sampled Signal at time t, held from the last sample at or before t. */
export function holdLookup(sig: SampledSignal, offsetS: number): (t: number) => number {
  let i = 0;
  return (t) => {
    const at = t + offsetS;
    while (i + 1 < sig.t.length && sig.t[i + 1]! <= at) i++;
    while (i > 0 && sig.t[i]! > at) i--;
    return sig.v[i] ?? 0;
  };
}

export async function runTimeAnalysis(
  projectPath: string,
  req: TimeAnalysisRequest,
  python: PythonRuntime | null = null,
  signal: SampledSignal | null = null,
  ctl?: AnalysisControl,
): Promise<TimeAnalysisResult> {
  const sys = await loadSystem(projectPath, req.system);
  const host = withPython(sys, python, ctl?.signal);
  try {
    return await timeAnalysis(sys, req, host ?? undefined, signal, ctl);
  } finally {
    host?.close();
  }
}

/** Starts a Python host when the System contains Python Blocks; aborting `abort` stops it at once. */
export function withPython(sys: LoadedSystem, python: PythonRuntime | null, abort?: AbortSignal): PythonHost | null {
  const needs = [...sys.defs.values()].some((d) => d.file.kind === "python");
  if (!needs) return null;
  if (!python) throw new ProtocolFailure("invalid_system", "This System has Python Blocks but the Project's Python environment is not ready");
  const host = new PythonHost(python);
  abort?.addEventListener("abort", () => host.kill(new ProtocolFailure("cancelled", "Analysis cancelled")), { once: true });
  return host;
}

async function timeAnalysis(
  sys: LoadedSystem,
  req: TimeAnalysisRequest,
  host?: PythonHost,
  signal: SampledSignal | null = null,
  ctl?: AnalysisControl,
): Promise<TimeAnalysisResult> {
  let engine: SystemEngine;
  try {
    engine = new SystemEngine(sys, req.parameters, host ? { python: host } : {});
  } catch (e) {
    if (e instanceof SystemError) throw new ProtocolFailure("invalid_system", e.message);
    throw e;
  }
  const input = req.input ?? engine.inputs[0];
  if (!input || !engine.inputs.includes(input)) {
    throw new ProtocolFailure("invalid_params", `System ${sys.name} has no input ${req.input ?? ""}`.trim());
  }
  const fs = engine.sampleRateHz;
  let drive: (k: number, t: number) => number;
  let durationS = req.durationS;
  if (req.kind === "signal") {
    if (!signal || !req.signal) throw new ProtocolFailure("invalid_params", 'kind "signal" needs a recorded signal');
    const span = (signal.t.at(-1) ?? 0) - req.signal.startS;
    if (span <= 0) throw new ProtocolFailure("invalid_params", "The recorded Signal has no samples after startS");
    durationS = Math.min(durationS, span);
    const look = holdLookup(signal, req.signal.startS);
    drive = (_k, t) => look(t);
  } else {
    const stim =
      req.kind === "step" ? { kind: "step" as const, amplitude: 1, startS: 0 }
      : req.kind === "impulse" ? { kind: "impulse" as const, area: 1 }
      : req.stimulus;
    if (!stim) throw new ProtocolFailure("invalid_params", 'kind "stimulus" needs a stimulus');
    drive = stimulusFn(stim, durationS, fs);
  }
  const count = Math.round(durationS * fs) + 1;
  checkSampleBudget(count, fs, durationS);
  const u = new Float64Array(count);
  let outputs: Float64Array[];
  try {
    outputs = await runChunked(
      engine,
      count,
      (name, k, t) => {
        if (name !== input) return 0;
        const v = drive(k, t);
        u[k] = v;
        return v;
      },
      ctl,
    );
  } catch (e) {
    if (e instanceof ProtocolFailure) throw e;
    throw new ProtocolFailure("invalid_system", `Simulation failed: ${(e as Error).message}`);
  }
  const series: Record<string, number[]> = { [input]: Array.from(u) };
  engine.outputs.forEach((name, i) => (series[name] = Array.from(outputs[i]!)));
  const times = Array.from({ length: count }, (_, k) => k / fs);
  return {
    system: req.system,
    kind: req.kind,
    input,
    sampleRateHz: fs,
    times,
    series,
    ...(req.kind === "step" ? { metrics: metricsFor(engine.outputs, times, series, linearFinalValues(sys, req.parameters, input)) } : {}),
  };
}

/** For linear Systems the final value is exact; an unstable linear System has no step Metrics. */
function metricsFor(
  outputs: string[],
  times: number[],
  series: Record<string, number[]>,
  finals: Record<string, number | null> | null,
): Record<string, StepMetrics> {
  const out: Record<string, StepMetrics> = {};
  for (const name of outputs) {
    const f = finals ? finals[name] : undefined;
    if (f === null) continue;
    out[name] = stepMetrics(times, series[name]!, f);
  }
  return out;
}
