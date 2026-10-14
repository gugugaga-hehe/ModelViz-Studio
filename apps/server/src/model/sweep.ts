import type { SweepAxis, SweepRequest, SweepResult } from "@modelviz/protocol";
import { ProtocolFailure } from "../errors.ts";
import { NotLinearError, bode, evalPoint, frequencyMetrics, linearFinalValues, logspace, loopMetrics, responseAt, stepMetrics, systemModel } from "./lti.ts";
import type { PythonHost } from "./python-host.ts";
import { type LoadedSystem, SystemEngine, SystemError, loadSystem } from "./system.ts";
import { withPython } from "./time-analysis.ts";

/** Grid points along one axis. */
export function axisValues(a: SweepAxis): number[] {
  if (a.scale === "log") {
    if (a.from <= 0 || a.to <= 0) throw new ProtocolFailure("invalid_params", `Log sweep of ${a.block}.${a.parameter} needs positive bounds`);
    return logspace(a.from, a.to, a.steps);
  }
  return Array.from({ length: a.steps }, (_, i) => a.from + ((a.to - a.from) * i) / (a.steps - 1));
}

export interface SweepControl {
  cancelled: boolean;
  progress(done: number, total: number): void;
}

const nextTick = () => new Promise<void>((r) => setImmediate(r));
const finite = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : v);

/**
 * Evaluates the requested Metrics over a 1-D or 2-D grid of Block Parameter values. Yields to
 * the event loop between points so progress, cancellation and other requests keep flowing.
 */
export async function runSweep(projectPath: string, req: SweepRequest, ctl: SweepControl, python: string | null = null): Promise<SweepResult> {
  const sys = await loadSystem(projectPath, req.system);
  if (sys.issues.length || !sys.file) throw new ProtocolFailure("invalid_system", sys.issues.map((i) => i.message).join("; "));
  const host = withPython(sys, python);
  try {
    return await sweep(sys, req, ctl, host);
  } finally {
    host?.close();
  }
}

async function sweep(sys: LoadedSystem, req: SweepRequest, ctl: SweepControl, host: PythonHost | null): Promise<SweepResult> {
  if (sys.issues.length || !sys.file) throw new ProtocolFailure("invalid_system", sys.issues.map((i) => i.message).join("; "));
  for (const a of req.axes) {
    const def = sys.defs.get(a.block);
    if (!def) throw new ProtocolFailure("invalid_params", `System has no Block ${a.block} with Block Parameters`);
    if (!(a.parameter in def.parameters)) throw new ProtocolFailure("invalid_params", `${a.block} has no Block Parameter ${a.parameter}`);
  }
  const m = req.metrics;
  if (!Object.keys(sys.file.outputs).includes(m.output)) throw new ProtocolFailure("invalid_params", `System has no output ${m.output}`);
  if (m.loop.length && !m.openLoopAt) throw new ProtocolFailure("invalid_params", "Loop Metrics need openLoopAt");
  const names = [...m.step, ...m.frequency, ...m.loop];
  if (!names.length) throw new ProtocolFailure("invalid_params", "Choose at least one Metric");

  const grids = req.axes.map(axisValues);
  const points = grids.length === 1 ? grids[0]!.map((v) => [v]) : grids[0]!.flatMap((a) => grids[1]!.map((b) => [a, b]));
  const total = points.length;
  const flat: Record<string, (number | null)[]> = Object.fromEntries(names.map((n) => [n, []]));
  const fs = sys.file.sampleRateHz;
  const nyq = fs / 2;

  for (let k = 0; k < total; k++) {
    if (ctl.cancelled) throw new ProtocolFailure("cancelled", "Parameter Sweep cancelled");
    const overrides: Record<string, Record<string, number>> = structuredClone(req.parameters);
    req.axes.forEach((a, i) => {
      overrides[a.block] = { ...(overrides[a.block] ?? {}), [a.parameter]: points[k]![i]! };
    });
    const record = (n: string, v: number | null) => flat[n]!.push(v);

    if (m.step.length) {
      try {
        const engine = new SystemEngine(sys, overrides, host ? { python: host } : {});
        const count = Math.round(m.durationS * fs) + 1;
        const out = await engine.run(count, (name) => (name === engine.inputs[0] ? 1 : 0));
        const times = Array.from({ length: count }, (_, i) => i / fs);
        const y = Array.from(out[engine.outputs.indexOf(m.output)]!);
        const finals = linearFinalValues(sys, overrides, engine.inputs[0]!);
        const final = finals ? finals[m.output] : undefined;
        const diverged = y.some((v) => !Number.isFinite(v)) || final === null;
        const met = diverged ? null : stepMetrics(times, y, final ?? undefined);
        for (const n of m.step) record(n, met ? finite(met[n]) : null);
      } catch (e) {
        if (!(e instanceof SystemError) && !(e instanceof Error)) throw e;
        for (const n of m.step) record(n, null);
      }
    }
    if (m.frequency.length || m.loop.length) {
      try {
        const model = systemModel(sys, overrides);
        const fMax = model.domain === "discrete" ? nyq * 0.9999 : nyq * 0.999;
        const freqs = logspace(Math.min(0.1, fMax / 1000), fMax, 300);
        if (m.frequency.length) {
          const o = model.outputs.indexOf(m.output);
          const data = bode(freqs.map((f) => responseAt(model, 0, evalPoint(model, f))[o]!));
          const met = frequencyMetrics(model, 0, o, freqs, data);
          for (const n of m.frequency) record(n, finite(met[n]));
        }
        if (m.loop.length) {
          const broken = systemModel(sys, overrides, m.openLoopAt);
          const li = broken.inputs.indexOf("__loop_in");
          const lo = broken.outputs.indexOf("__loop_out");
          const data = bode(
            freqs.map((f) => {
              const h = responseAt(broken, li, evalPoint(broken, f))[lo]!;
              return [-h[0], -h[1]] as [number, number];
            }),
          );
          const met = loopMetrics(broken, li, lo, freqs, data);
          for (const n of m.loop) record(n, finite(met[n]));
        }
      } catch (e) {
        if (e instanceof NotLinearError) throw new ProtocolFailure("invalid_system", `Frequency Metrics need a linear System: ${e.message}`);
        for (const n of [...m.frequency, ...m.loop]) record(n, null);
      }
    }
    ctl.progress(k + 1, total);
    await nextTick();
  }

  const values: SweepResult["values"] = {};
  for (const n of names) {
    const list = flat[n]!;
    values[n] = grids.length === 1 ? list : grids[0]!.map((_, i) => list.slice(i * grids[1]!.length, (i + 1) * grids[1]!.length));
  }
  return { id: req.id, system: req.system, axes: req.axes.map((a, i) => ({ ...a, values: grids[i]! })), values };
}
