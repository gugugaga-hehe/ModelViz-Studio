import type { StepMetrics, TimeAnalysisRequest, TimeAnalysisResult } from "@modelviz/protocol";
import { ProtocolFailure } from "../errors.ts";
import { linearFinalValues, stepMetrics } from "./lti.ts";
import { stimulusFn } from "./stimulus.ts";
import { PythonHost } from "./python-host.ts";
import { type LoadedSystem, SystemEngine, SystemError, loadSystem } from "./system.ts";

/** Runs a step, impulse or Stimulus response of a System from rest. */
export async function runTimeAnalysis(projectPath: string, req: TimeAnalysisRequest, python: string | null = null): Promise<TimeAnalysisResult> {
  const sys = await loadSystem(projectPath, req.system);
  const host = withPython(sys, python);
  try {
    return await timeAnalysis(sys, req, host ?? undefined);
  } finally {
    host?.close();
  }
}

/** Starts a Python host when the System contains Python Blocks. */
export function withPython(sys: LoadedSystem, python: string | null): PythonHost | null {
  const needs = [...sys.defs.values()].some((d) => d.file.kind === "python");
  if (!needs) return null;
  if (!python) throw new ProtocolFailure("invalid_system", "This System has Python Blocks but the Project's Python environment is not ready");
  return new PythonHost(python);
}

async function timeAnalysis(sys: LoadedSystem, req: TimeAnalysisRequest, host?: PythonHost): Promise<TimeAnalysisResult> {
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
  const stim =
    req.kind === "step" ? { kind: "step" as const, amplitude: 1, startS: 0 }
    : req.kind === "impulse" ? { kind: "impulse" as const, area: 1 }
    : req.stimulus;
  if (!stim) throw new ProtocolFailure("invalid_params", 'kind "stimulus" needs a stimulus');
  const fs = engine.sampleRateHz;
  const count = Math.round(req.durationS * fs) + 1;
  const drive = stimulusFn(stim, req.durationS, fs);
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
