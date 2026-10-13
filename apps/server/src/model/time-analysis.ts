import type { TimeAnalysisRequest, TimeAnalysisResult } from "@modelviz/protocol";
import { ProtocolFailure } from "../errors.ts";
import { stimulusFn } from "./stimulus.ts";
import { SystemEngine, SystemError, loadSystem } from "./system.ts";

/** Runs a step, impulse or Stimulus response of a System from rest. */
export async function runTimeAnalysis(projectPath: string, req: TimeAnalysisRequest): Promise<TimeAnalysisResult> {
  const sys = await loadSystem(projectPath, req.system);
  let engine: SystemEngine;
  try {
    engine = new SystemEngine(sys, req.parameters);
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
    outputs = engine.run(count, (name, k, t) => {
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
  return {
    system: req.system,
    kind: req.kind,
    input,
    sampleRateHz: fs,
    times: Array.from({ length: count }, (_, k) => k / fs),
    series,
  };
}
