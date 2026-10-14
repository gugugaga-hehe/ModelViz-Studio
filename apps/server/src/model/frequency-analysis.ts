import type { FrequencyAnalysisRequest, FrequencyAnalysisResult, PoleZeroResult } from "@modelviz/protocol";
import { ProtocolFailure } from "../errors.ts";
import { NotLinearError, type SystemModel, bode, evalPoint, frequencyMetrics, isStable, logspace, loopMetrics, poles, responseAt, systemModel, zerosOf } from "./lti.ts";
import { type MeasureControl, breakLoop, gridLoopMetrics, gridMetrics, measureResponses, toBode } from "./measured.ts";
import { type LoadedSystem, loadSystem } from "./system.ts";
import type { PythonRuntime } from "./python-host.ts";
import { withPython } from "./time-analysis.ts";

async function linearSystem(projectPath: string, path: string, overrides: Record<string, Record<string, number>>, breakAt?: string) {
  const sys: LoadedSystem = await loadSystem(projectPath, path);
  if (sys.issues.length || !sys.file) throw new ProtocolFailure("invalid_system", sys.issues.map((i) => i.message).join("; "));
  try {
    return { sys, model: systemModel(sys, overrides, breakAt) };
  } catch (e) {
    if (e instanceof NotLinearError) {
      throw new ProtocolFailure("invalid_system", `Analytic analysis needs a linear System: ${e.message}`);
    }
    throw e;
  }
}

function inputIndex(model: SystemModel, name: string | undefined, system: string): [number, string] {
  const input = name ?? model.inputs[0];
  const i = input === undefined ? -1 : model.inputs.indexOf(input);
  if (i < 0 || input === "__loop_in") throw new ProtocolFailure("invalid_params", `System ${system} has no input ${name ?? ""}`.trim());
  return [i, input!];
}

export async function runFrequencyAnalysis(
  projectPath: string,
  req: FrequencyAnalysisRequest,
  python: PythonRuntime | null = null,
  ctl: MeasureControl = { cancelled: false, progress: () => {} },
): Promise<FrequencyAnalysisResult> {
  if (req.method === "measured") return runMeasured(projectPath, req, python, ctl);
  if (req.method === "auto") {
    const sys = await loadSystem(projectPath, req.system);
    const linear = !!sys.file && !sys.issues.length && [...sys.defs.values()].every((d) => d.linear && d.domain !== "python");
    if (!linear) return runMeasured(projectPath, req, python, ctl);
  }
  // Closed-loop responses come from the intact System; the loop transfer from a copy with
  // the chosen Connection cut.
  const { sys, model } = await linearSystem(projectPath, req.system, req.parameters);
  const [inp, input] = inputIndex(model, req.input, sys.name);
  const nyquist = sys.file!.sampleRateHz / 2;
  const fMax = Math.min(req.fMaxHz ?? nyquist * 0.999, model.domain === "discrete" ? nyquist * 0.9999 : Number.POSITIVE_INFINITY);
  const fMin = req.fMinHz ?? Math.min(0.1, fMax / 1000);
  if (!(fMin < fMax)) throw new ProtocolFailure("invalid_params", `Frequency range is empty (${fMin}–${fMax} Hz)`);
  const freqs = logspace(fMin, fMax, req.points);
  const values = freqs.map((f) => responseAt(model, inp, evalPoint(model, f)));
  const responses: FrequencyAnalysisResult["responses"] = {};
  const metrics: FrequencyAnalysisResult["metrics"] = {};
  model.outputs.forEach((name, o) => {
    const data = bode(values.map((v) => v[o]!));
    responses[name] = data;
    metrics[name] = frequencyMetrics(model, inp, o, freqs, data);
  });
  let loop: FrequencyAnalysisResult["loop"];
  if (req.openLoopAt) {
    const broken = (await linearSystem(projectPath, req.system, req.parameters, req.openLoopAt)).model;
    const li = broken.inputs.indexOf("__loop_in");
    const lo = broken.outputs.indexOf("__loop_out");
    const lv = freqs.map((f) => {
      const h = responseAt(broken, li, evalPoint(broken, f))[lo]!;
      return [-h[0], -h[1]] as [number, number];
    });
    const data = bode(lv);
    loop = { at: req.openLoopAt, ...data, ...loopMetrics(broken, li, lo, freqs, data) };
  }
  return {
    system: req.system,
    input,
    method: "analytic",
    domain: model.domain,
    frequencies: freqs,
    responses,
    metrics,
    ...(loop ? { loop } : {}),
  };
}

export async function runPoleZero(
  projectPath: string,
  req: { system: string; input?: string; parameters: Record<string, Record<string, number>> },
): Promise<PoleZeroResult> {
  const { sys, model } = await linearSystem(projectPath, req.system, req.parameters);
  const [inp, input] = inputIndex(model, req.input, sys.name);
  const ps = poles(model);
  const zs: PoleZeroResult["zeros"] = {};
  model.outputs.forEach((name, o) => (zs[name] = zerosOf(model, inp, o)));
  return { system: req.system, input, domain: model.domain, poles: ps, zeros: zs, stable: isStable(model, ps) };
}

const MEASURED_POINTS = 40;

/** Measured Frequency Response (stepped sines) for any System, including nonlinear ones. */
async function runMeasured(projectPath: string, req: FrequencyAnalysisRequest, python: PythonRuntime | null, ctl: MeasureControl): Promise<FrequencyAnalysisResult> {
  const sys = await loadSystem(projectPath, req.system);
  if (sys.issues.length || !sys.file) throw new ProtocolFailure("invalid_system", sys.issues.map((i) => i.message).join("; "));
  const input = req.input ?? sys.file.inputs[0];
  if (!input || !sys.file.inputs.includes(input)) throw new ProtocolFailure("invalid_params", `System ${sys.name} has no input ${req.input ?? ""}`.trim());
  const nyquist = sys.file.sampleRateHz / 2;
  const fMax = Math.min(req.fMaxHz ?? nyquist * 0.5, nyquist * 0.95);
  const fMin = req.fMinHz ?? Math.max(1, fMax / 500);
  if (!(fMin < fMax)) throw new ProtocolFailure("invalid_params", `Frequency range is empty (${fMin}–${fMax} Hz)`);
  const freqs = logspace(fMin, fMax, Math.min(req.points, MEASURED_POINTS));
  const host = withPython(sys, python, ctl.signal);
  try {
    const parts = req.openLoopAt ? 2 : 1;
    const progress = (offset: number) => (done: number, total: number) => ctl.progress(offset + done, total * parts);
    const closed = await measureResponses(sys, input, freqs, req.amplitude, req.parameters, host, { get cancelled() { return ctl.cancelled; }, progress: progress(0) });
    const responses: FrequencyAnalysisResult["responses"] = {};
    const metrics: FrequencyAnalysisResult["metrics"] = {};
    for (const [name, vals] of Object.entries(closed.values)) {
      const data = toBode(vals);
      responses[name] = data;
      metrics[name] = gridMetrics(freqs, data);
    }
    let loop: FrequencyAnalysisResult["loop"];
    if (req.openLoopAt) {
      const broken = breakLoop(sys, req.openLoopAt);
      const m = await measureResponses(broken, "__loop_in", freqs, req.amplitude, req.parameters, host, {
        get cancelled() {
          return ctl.cancelled;
        },
        progress: progress(freqs.length),
      });
      const data = toBode(m.values.__loop_out!.map(([re, im]) => [-re, -im]));
      loop = { at: req.openLoopAt, ...data, ...gridLoopMetrics(freqs, data) };
    }
    return { system: req.system, input, method: "measured", domain: closed.domain, frequencies: freqs, responses, metrics, ...(loop ? { loop } : {}) };
  } finally {
    host?.close();
  }
}
