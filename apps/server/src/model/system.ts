import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { SystemFile, type ValidationIssue } from "@modelviz/protocol";
import { parse } from "yaml";
import { type BlockDef, BlockError, type BlockRuntime, gainRuntime, instantiate, loadBlock, parameterValues, sumRuntime } from "./block.ts";
import { PythonBlockRuntime, type PythonHost } from "./python-host.ts";

/** A System file with its Blocks resolved and checked (not yet executing). */
export interface LoadedSystem {
  path: string;
  name: string;
  file: SystemFile | null;
  /** Block definitions by System Block name (built-ins have none). */
  defs: Map<string, BlockDef>;
  issues: ValidationIssue[];
}

export class SystemError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((i) => i.message).join("; "));
  }
}

export function systemName(path: string): string {
  return basename(path, extname(path));
}

const RATE_EPS = 1e-9;

export async function loadSystem(projectPath: string, relPath: string): Promise<LoadedSystem> {
  const name = systemName(relPath);
  const out: LoadedSystem = { path: relPath, name, file: null, defs: new Map(), issues: [] };
  let text: string;
  try {
    text = await readFile(resolve(projectPath, relPath), "utf8");
  } catch {
    out.issues.push({ code: "invalid_file", message: `System file not found: ${relPath}` });
    return out;
  }
  const parsed = SystemFile.safeParse(parse(text));
  if (!parsed.success) {
    out.issues.push({
      code: "invalid_file",
      message: `Invalid System ${relPath}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    });
    return out;
  }
  out.file = parsed.data;
  for (const [bname, b] of Object.entries(parsed.data.blocks)) {
    if (!("block" in b)) continue;
    try {
      out.defs.set(bname, await loadBlock(projectPath, b.block));
    } catch (e) {
      out.issues.push({ code: e instanceof BlockError ? "invalid_block" : "unknown_block", message: `${bname}: ${(e as Error).message}` });
    }
  }
  if (!out.issues.length) out.issues.push(...validate(out));
  return out;
}

interface Node {
  name: string;
  inputs: string[];
  outputs: string[];
  feedthrough: boolean;
}

export interface EngineOptions {
  /** Hosts Python Blocks; required when the System contains any. */
  python?: PythonHost;
}

/** A Block runtime, or a Python Block (processed in chunks through the Python host). */
type Runtime = { kind: "ts"; rt: BlockRuntime } | { kind: "py"; rt: PythonBlockRuntime };

interface NodeRt extends Node {
  run: Runtime;
}

/** Port lists, feedthrough and runtimes of each System Block (built-ins included). */
function nodes(sys: LoadedSystem, overrides: Record<string, Record<string, number>> = {}, opts: EngineOptions | null = null): Map<string, NodeRt> {
  const file = sys.file!;
  const out = new Map<string, NodeRt>();
  for (const [name, b] of Object.entries(file.blocks)) {
    let run: Runtime;
    if ("block" in b) {
      const def = sys.defs.get(name)!;
      const params = { ...b.parameters, ...(overrides[name] ?? {}) };
      if (def.file.kind === "python") {
        // Validation only needs ports; execution needs the host.
        if (!opts) {
          out.set(name, { name, inputs: def.inputs, outputs: def.outputs, feedthrough: true, run: null as never });
          continue;
        }
        if (!opts.python) throw new BlockError(`${name}: Python Blocks need the Project's Python environment, which is not ready`);
        parameterValues(def, params);
        const values = parameterValues(def, params);
        run = {
          kind: "py",
          rt: new PythonBlockRuntime(opts.python, def.path, def.modulePath!, def.file.class, values, file.sampleRateHz, def.inputs, def.outputs),
        };
      } else {
        run = { kind: "ts", rt: instantiate(def, params, file.sampleRateHz) };
      }
    } else if (b.kind === "sum") run = { kind: "ts", rt: sumRuntime(b.signs) };
    else run = { kind: "ts", rt: gainRuntime(b.gain) };
    out.set(name, { name, inputs: run.rt.inputs, outputs: run.rt.outputs, feedthrough: run.rt.feedthrough, run });
  }
  return out;
}

function validate(sys: LoadedSystem): ValidationIssue[] {
  const file = sys.file!;
  const issues: ValidationIssue[] = [];
  for (const [name, def] of sys.defs) {
    if (def.domain === "discrete" && def.sampleRateHz && Math.abs(def.sampleRateHz - file.sampleRateHz) > RATE_EPS) {
      issues.push({
        code: "sample_rate_mismatch",
        message: `${name} (${def.path}) is designed for ${def.sampleRateHz} Hz but the System runs at ${file.sampleRateHz} Hz`,
      });
    }
  }
  let ns: Map<string, Node>;
  try {
    ns = nodes(sys);
  } catch (e) {
    return [...issues, { code: "invalid_block", message: (e as Error).message }];
  }
  const inputs = new Set(file.inputs);

  const checkSource = (ep: string, where: string) => {
    if (!ep.includes(".")) {
      if (!inputs.has(ep)) issues.push({ code: "unknown_port", message: `${where}: "${ep}" is not a System input` });
      return;
    }
    const [b, port] = ep.split(".") as [string, string];
    const n = ns.get(b);
    if (!n) issues.push({ code: "unknown_block", message: `${where}: no Block named ${b}` });
    else if (!n.outputs.includes(port)) issues.push({ code: "unknown_port", message: `${where}: ${b} has no output Port ${port} (has ${n.outputs.join(", ")})` });
  };

  const drivers = new Map<string, string[]>();
  for (const c of file.connections) {
    checkSource(c.from, `Connection ${c.from} → ${c.to}`);
    if (!c.to.includes(".")) {
      issues.push({ code: "unknown_port", message: `Connection ${c.from} → ${c.to}: target must be block.port` });
      continue;
    }
    const [b, port] = c.to.split(".") as [string, string];
    const n = ns.get(b);
    if (!n) issues.push({ code: "unknown_block", message: `Connection ${c.from} → ${c.to}: no Block named ${b}` });
    else if (!n.inputs.includes(port)) issues.push({ code: "unknown_port", message: `Connection ${c.from} → ${c.to}: ${b} has no input Port ${port} (has ${n.inputs.join(", ")})` });
    drivers.set(c.to, [...(drivers.get(c.to) ?? []), c.from]);
  }
  for (const [to, from] of drivers) {
    if (from.length > 1) issues.push({ code: "multiple_drivers", message: `${to} is driven by ${from.join(" and ")}` });
  }
  for (const n of ns.values()) {
    for (const port of n.inputs) {
      if (!drivers.has(`${n.name}.${port}`)) issues.push({ code: "unconnected_port", message: `Input Port ${n.name}.${port} is not connected` });
    }
  }
  for (const [out, ep] of Object.entries(file.outputs)) checkSource(ep, `Output ${out}`);
  if (!issues.length) {
    const loop = findAlgebraicLoop(ns, file.connections);
    if (loop) issues.push({ code: "algebraic_loop", message: `Algebraic loop through ${loop.join(" → ")}: add a Block with no direct feedthrough` });
  }
  return issues;
}

/** Evaluation order for feedthrough Blocks; returns a cycle if there is one. */
function feedthroughOrder(
  ns: Map<string, Node>,
  connections: { from: string; to: string }[],
): { order: string[]; cycle: string[] | null } {
  const ft = [...ns.values()].filter((n) => n.feedthrough).map((n) => n.name);
  const ftSet = new Set(ft);
  const deps = new Map<string, Set<string>>(ft.map((n) => [n, new Set()]));
  for (const c of connections) {
    const src = c.from.split(".")[0]!;
    const dst = c.to.split(".")[0]!;
    if (c.from.includes(".") && ftSet.has(src) && ftSet.has(dst)) deps.get(dst)!.add(src);
  }
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const visit = (n: string): void => {
    if (cycle || state.get(n) === "done") return;
    if (state.get(n) === "visiting") {
      cycle = [...stack.slice(stack.indexOf(n)), n];
      return;
    }
    state.set(n, "visiting");
    stack.push(n);
    for (const d of deps.get(n)!) visit(d);
    stack.pop();
    state.set(n, "done");
    order.push(n);
  };
  for (const n of ft) visit(n);
  return { order, cycle };
}

function findAlgebraicLoop(ns: Map<string, Node>, connections: { from: string; to: string }[]): string[] | null {
  return feedthroughOrder(ns, connections).cycle;
}

/**
 * Strongly connected components of the Block graph (Tarjan), in dependency order: every
 * component only reads from components before it.
 */
function components(names: string[], connections: { from: string; to: string }[]): { members: string[]; cyclic: boolean }[] {
  const succ = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const c of connections) {
    if (!c.from.includes(".")) continue;
    succ.get(c.from.split(".")[0]!)!.add(c.to.split(".")[0]!);
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: { members: string[]; cyclic: boolean }[] = [];
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of succ.get(v)!) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const members: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        members.push(w);
      } while (w !== v);
      out.push({ members, cyclic: members.length > 1 || succ.get(v)!.has(v) });
    }
  };
  for (const n of names) if (!idx.has(n)) strong(n);
  // Tarjan emits sinks first
  return out.reverse();
}

/**
 * An executing System. Each run processes a chunk of samples (ADR-0010) stage by stage:
 * the Block graph is split into strongly connected components processed in dependency order.
 * A component without a cycle processes the whole chunk at once (one call for a Python Block);
 * a feedback loop is stepped sample by sample so it stays exact, calling Python Blocks inside
 * it once per sample (ADR-0011).
 */
export class SystemEngine {
  readonly sampleRateHz: number;
  readonly inputs: string[];
  readonly outputs: string[];
  private readonly ns: Map<string, NodeRt>;
  private readonly stages: { members: string[]; cyclic: boolean; order: string[] }[];
  /** For each Block, where each input Port reads from. */
  private readonly wiring: Map<string, string[]>;
  private readonly outputSources: string[];
  private k = 0;

  constructor(sys: LoadedSystem, overrides: Record<string, Record<string, number>> = {}, opts: EngineOptions = {}) {
    if (sys.issues.length || !sys.file) throw new SystemError(sys.issues);
    const file = sys.file;
    for (const b of Object.keys(overrides)) {
      if (!(b in file.blocks)) throw new SystemError([{ code: "unknown_block", message: `Parameter override for unknown Block ${b}` }]);
    }
    try {
      this.ns = nodes(sys, overrides, opts);
    } catch (e) {
      throw new SystemError([{ code: "invalid_block", message: (e as Error).message }]);
    }
    this.sampleRateHz = file.sampleRateHz;
    this.inputs = file.inputs;
    this.outputs = Object.keys(file.outputs);
    this.outputSources = Object.values(file.outputs);
    const ftOrder = feedthroughOrder(this.ns, file.connections).order;
    this.stages = components([...this.ns.keys()], file.connections).map((c) => {
      const set = new Set(c.members);
      // within a loop: Blocks without feedthrough first, then feedthrough Blocks in dependency order
      const order = [...c.members.filter((m) => !this.ns.get(m)!.feedthrough), ...ftOrder.filter((m) => set.has(m))];
      return { ...c, order };
    });
    const drv = new Map(file.connections.map((c) => [c.to, c.from]));
    this.wiring = new Map([...this.ns.values()].map((n) => [n.name, n.inputs.map((p) => drv.get(`${n.name}.${p}`)!)]));
  }

  async reset(): Promise<void> {
    for (const n of this.ns.values()) await n.run.rt.reset();
    this.k = 0;
  }

  /**
   * Runs `count` samples. `input(name, k, t)` supplies System input values; returns one array
   * per System output.
   */
  async run(count: number, input: (name: string, k: number, t: number) => number): Promise<Float64Array[]> {
    const dt = 1 / this.sampleRateHz;
    const k0 = this.k;
    const t = Float64Array.from({ length: count }, (_, i) => (k0 + i) * dt);
    const values = new Map<string, Float64Array>();
    for (const name of this.inputs) values.set(name, Float64Array.from({ length: count }, (_, i) => input(name, k0 + i, t[i]!)));
    for (const n of this.ns.values()) for (const p of n.outputs) values.set(`${n.name}.${p}`, new Float64Array(count));
    const src = (ep: string) => values.get(ep)!;

    for (const stage of this.stages) {
      if (!stage.cyclic) {
        const n = this.ns.get(stage.members[0]!)!;
        const ins = this.wiring.get(n.name)!.map(src);
        if (n.run.kind === "py") {
          const outs = await n.run.rt.process(t, ins);
          n.outputs.forEach((p, j) => values.get(`${n.name}.${p}`)!.set(outs[j]!));
        } else {
          const rt = n.run.rt;
          const outs = n.outputs.map((p) => values.get(`${n.name}.${p}`)!);
          for (let i = 0; i < count; i++) {
            const u = ins.map((a) => a[i]!);
            const y = rt.output(u, t[i]!);
            for (let j = 0; j < y.length; j++) outs[j]![i] = y[j]!;
            rt.update(u, t[i]!);
          }
        }
        continue;
      }
      // feedback loop: step every member sample by sample
      const members = stage.order.map((m) => this.ns.get(m)!);
      const wiring = members.map((n) => this.wiring.get(n.name)!.map(src));
      const outs = members.map((n) => n.outputs.map((p) => values.get(`${n.name}.${p}`)!));
      for (let i = 0; i < count; i++) {
        const us: number[][] = [];
        for (let m = 0; m < members.length; m++) {
          const n = members[m]!;
          // non-feedthrough outputs do not depend on current inputs; pass zeros
          const u = n.feedthrough ? wiring[m]!.map((a) => a[i]!) : n.inputs.map(() => 0);
          let y: ArrayLike<number>;
          if (n.run.kind === "py") {
            const o = await n.run.rt.process(t.subarray(i, i + 1), u.map((v) => Float64Array.of(v)));
            y = o.map((a) => a[0]!);
          } else y = n.run.rt.output(u, t[i]!);
          for (let j = 0; j < y.length; j++) outs[m]![j]![i] = y[j]!;
          us.push(u);
        }
        for (let m = 0; m < members.length; m++) {
          const n = members[m]!;
          if (n.run.kind === "py") continue; // process() already advanced it
          n.run.rt.update(wiring[m]!.map((a) => a[i]!), t[i]!);
        }
      }
    }
    this.k += count;
    return this.outputSources.map((ep) => Float64Array.from(values.get(ep)!));
  }
}
