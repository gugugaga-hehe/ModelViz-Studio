import type { FrequencyAnalysisRequest, FrequencyAnalysisResult, PoleZeroResult } from "@modelviz/protocol";
import { ProtocolFailure } from "../errors.ts";
import { NotLinearError, type SystemModel, bode, evalPoint, frequencyMetrics, isStable, logspace, loopMetrics, poles, responseAt, systemModel, zerosOf } from "./lti.ts";
import { type LoadedSystem, loadSystem } from "./system.ts";

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

export async function runFrequencyAnalysis(projectPath: string, req: FrequencyAnalysisRequest): Promise<FrequencyAnalysisResult> {
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
