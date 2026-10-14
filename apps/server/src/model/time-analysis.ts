import type { StepMetrics, TimeAnalysisRequest, TimeAnalysisResult } from "@modelviz/protocol";
import { ProtocolFailure } from "../errors.ts";
import { linearFinalValues, stepMetrics } from "./lti.ts";
import { stimulusFn } from "./stimulus.ts";
import { PythonHost, type PythonRuntime } from "./python-host.ts";
import { type LoadedSystem, SystemEngine, SystemError, loadSystem } from "./system.ts";

/** Runs a step, impulse or Stimulus response of a System from rest. */
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
  abort?: AbortSignal,
): Promise<TimeAnalysisResult> {
  const sys = await loadSystem(projectPath, req.system);
  const host = withPython(sys, python, abort);
  try {
    return await timeAnalysis(sys, req, host ?? undefined, signal);
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

async function timeAnalysis(sys: LoadedSystem, req: TimeAnalysisRequest, host?: PythonHost, signal: SampledSignal | null = null): Promise<TimeAnalysisResult> {
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
  const u = new Float64Array(count);
  let outputs: Float64Array[];
  try {
    outputs = await engine.run(count, (name, k, t) => {
      if (name !== input) return 0;
      const v = drive(k, t);
      u[k] = v;
      return v;
    });
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
