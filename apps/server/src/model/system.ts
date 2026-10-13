import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { SystemFile, type ValidationIssue } from "@modelviz/protocol";
import { parse } from "yaml";
import { type BlockDef, BlockError, type BlockRuntime, gainRuntime, instantiate, loadBlock, sumRuntime } from "./block.ts";

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

/** Port lists and feedthrough of each System Block (built-ins included), with default parameters. */
function nodes(sys: LoadedSystem, overrides: Record<string, Record<string, number>> = {}): Map<string, Node & { rt: BlockRuntime }> {
  const file = sys.file!;
  const out = new Map<string, Node & { rt: BlockRuntime }>();
  for (const [name, b] of Object.entries(file.blocks)) {
    let rt: BlockRuntime;
    if ("block" in b) {
      rt = instantiate(sys.defs.get(name)!, { ...b.parameters, ...(overrides[name] ?? {}) }, file.sampleRateHz);
    } else if (b.kind === "sum") rt = sumRuntime(b.signs);
    else rt = gainRuntime(b.gain);
    out.set(name, { name, inputs: rt.inputs, outputs: rt.outputs, feedthrough: rt.feedthrough, rt });
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
  let ns: Map<string, Node & { rt: BlockRuntime }>;
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

/** An executing System: steps all Blocks one sample at a time, in dependency order. */
export class SystemEngine {
  readonly sampleRateHz: number;
  readonly inputs: string[];
  readonly outputs: string[];
  private readonly ns: Map<string, Node & { rt: BlockRuntime }>;
  private readonly order: string[];
  private readonly nonFeedthrough: string[];
  /** For each Block, where each input Port reads from. */
  private readonly wiring: Map<string, string[]>;
  private readonly outputSources: string[];
  private readonly values = new Map<string, number>();
  private k = 0;

  constructor(sys: LoadedSystem, overrides: Record<string, Record<string, number>> = {}) {
    if (sys.issues.length || !sys.file) throw new SystemError(sys.issues);
    const file = sys.file;
    for (const [b, o] of Object.entries(overrides)) {
      if (!(b in file.blocks)) throw new SystemError([{ code: "unknown_block", message: `Parameter override for unknown Block ${b}` }]);
      void o;
    }
    try {
      this.ns = nodes(sys, overrides);
    } catch (e) {
      throw new SystemError([{ code: "invalid_block", message: (e as Error).message }]);
    }
    this.sampleRateHz = file.sampleRateHz;
    this.inputs = file.inputs;
    this.outputs = Object.keys(file.outputs);
    this.outputSources = Object.values(file.outputs);
    this.order = feedthroughOrder(this.ns, file.connections).order;
    this.nonFeedthrough = [...this.ns.values()].filter((n) => !n.feedthrough).map((n) => n.name);
    const drv = new Map(file.connections.map((c) => [c.to, c.from]));
    this.wiring = new Map([...this.ns.values()].map((n) => [n.name, n.inputs.map((p) => drv.get(`${n.name}.${p}`)!)]));
  }

  reset(): void {
    for (const n of this.ns.values()) n.rt.reset();
    this.values.clear();
    this.k = 0;
  }

  /**
   * Runs `count` samples. `input(name, k, t)` supplies System input values; returns one array
   * per System output. Blocks process the chunk sample by sample internally, so feedback
   * loops are exact (ADR-0010 chunks are the unit of scheduling, not of numerical coupling).
   */
  run(count: number, input: (name: string, k: number, t: number) => number): Float64Array[] {
    const out = this.outputs.map(() => new Float64Array(count));
    const dt = 1 / this.sampleRateHz;
    const gather = (name: string) => this.wiring.get(name)!.map((ep) => this.values.get(ep) ?? 0);
    for (let i = 0; i < count; i++, this.k++) {
      const t = this.k * dt;
      for (const name of this.inputs) this.values.set(name, input(name, this.k, t));
      // Outputs of non-feedthrough Blocks do not depend on current inputs; pass zeros.
      for (const name of this.nonFeedthrough) {
        const rt = this.ns.get(name)!.rt;
        this.emit(name, rt.output(rt.inputs.map(() => 0), t));
      }
      for (const name of this.order) this.emit(name, this.ns.get(name)!.rt.output(gather(name), t));
      this.outputSources.forEach((ep, j) => (out[j]![i] = this.values.get(ep) ?? 0));
      for (const n of this.ns.values()) n.rt.update(gather(n.name), t);
    }
    return out;
  }

  private emit(name: string, y: number[]): void {
    const n = this.ns.get(name)!;
    n.outputs.forEach((p, i) => this.values.set(`${name}.${p}`, y[i]!));
  }
}
