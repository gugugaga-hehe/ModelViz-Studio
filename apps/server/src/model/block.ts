import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BlockFile, type Expr, type ParameterSpec } from "@modelviz/protocol";
import { parse } from "yaml";
import { type Compiled, ExprError, compile, evaluate } from "./expr.ts";
import { type Matrix, type StateSpace, matVec, rk4Step, tf2ss } from "./linear.ts";

export class BlockError extends Error {}

/** A loaded Block definition, independent of any System. */
export interface BlockDef {
  path: string;
  file: BlockFile;
  inputs: string[];
  outputs: string[];
  parameters: Record<string, ParameterSpec>;
  /** Continuous or discrete; formulas are memoryless and work at any rate. */
  domain: "continuous" | "discrete" | "memoryless";
  /** Rate a discrete Block was designed for. */
  sampleRateHz?: number;
  linear: boolean;
}

/** One executing Block inside a System, stepping one sample at a time. */
export interface BlockRuntime {
  readonly inputs: string[];
  readonly outputs: string[];
  /** Outputs depend on the current inputs (direct feedthrough). */
  readonly feedthrough: boolean;
  /** Computes outputs for sample time t from the current state (and inputs if feedthrough). */
  output(u: number[], t: number): number[];
  /** Advances the state by one sample with inputs u. */
  update(u: number[], t: number): void;
  reset(): void;
}

export async function loadBlock(projectPath: string, relPath: string): Promise<BlockDef> {
  let text: string;
  try {
    text = await readFile(resolve(projectPath, relPath), "utf8");
  } catch {
    throw new BlockError(`Block file not found: ${relPath}`);
  }
  const parsed = BlockFile.safeParse(parse(text));
  if (!parsed.success) throw new BlockError(`Invalid Block ${relPath}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const def = defineBlock(relPath, parsed.data);
  return def;
}

/** Builds and checks a Block definition from file contents (also for in-memory Blocks). */
export function defineBlock(path: string, file: BlockFile): BlockDef {
  const def = describe(path, file);
  instantiate(def, {}, def.sampleRateHz ?? 1000);
  return def;
}

function describe(path: string, file: BlockFile): BlockDef {
  const base = { path, file, parameters: file.parameters };
  switch (file.kind) {
    case "transfer-function":
      if (file.domain === "discrete" && !file.sampleRateHz) throw new BlockError(`${path}: discrete Blocks need sampleRateHz`);
      return {
        ...base,
        inputs: [file.input],
        outputs: [file.output],
        domain: file.domain,
        ...(file.sampleRateHz ? { sampleRateHz: file.sampleRateHz } : {}),
        linear: true,
      };
    case "state-space": {
      if (file.domain === "discrete" && !file.sampleRateHz) throw new BlockError(`${path}: discrete Blocks need sampleRateHz`);
      const m = file.B[0]?.length ?? file.D[0]?.length ?? 0;
      const p = file.C.length || file.D.length;
      return {
        ...base,
        inputs: file.inputs ?? Array.from({ length: m }, (_, i) => (m === 1 ? "u" : `u${i + 1}`)),
        outputs: file.outputs ?? Array.from({ length: p }, (_, i) => (p === 1 ? "y" : `y${i + 1}`)),
        domain: file.domain,
        ...(file.sampleRateHz ? { sampleRateHz: file.sampleRateHz } : {}),
        linear: true,
      };
    }
    case "difference-equation":
      return {
        ...base,
        inputs: file.inputs,
        outputs: Object.keys(file.equations),
        domain: "discrete",
        sampleRateHz: file.sampleRateHz,
        linear: file.linear,
      };
    case "formula":
      return { ...base, inputs: file.inputs, outputs: Object.keys(file.outputs), domain: "memoryless", linear: file.linear };
  }
}

/** Resolves Block Parameter values: defaults, then overrides; unknown overrides are errors. */
export function parameterValues(def: BlockDef, overrides: Record<string, number>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [k, spec] of Object.entries(def.parameters)) values[k] = spec.default;
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in def.parameters)) throw new BlockError(`${def.path}: unknown Block Parameter ${k}`);
    values[k] = v;
  }
  return values;
}

function evalAll(list: Expr[], scope: Record<string, number>, where: string): number[] {
  return list.map((e) => {
    try {
      return evaluate(e, scope);
    } catch (err) {
      throw new BlockError(`${where}: ${(err as Error).message}`);
    }
  });
}

/** Gain matrix of a linear formula Block, found by probing unit inputs. */
export function formulaGain(def: BlockDef, overrides: Record<string, number>): number[][] {
  const f = def.file;
  if (f.kind !== "formula") throw new BlockError(`${def.path} is not a formula`);
  const rt = instantiate(def, overrides, 1);
  const y0 = rt.output(f.inputs.map(() => 0), 0);
  if (y0.some((v) => Math.abs(v) > 1e-12)) throw new BlockError(`${def.path} is not linear (non-zero output for zero input)`);
  const cols = f.inputs.map((_, i) => rt.output(f.inputs.map((_, j) => (j === i ? 1 : 0)), 0));
  const twice = f.inputs.map((_, i) => rt.output(f.inputs.map((_, j) => (j === i ? 2 : 0)), 0));
  cols.forEach((c, i) => c.forEach((v, o) => {
    if (Math.abs(twice[i]![o]! - 2 * v) > 1e-9 * Math.max(1, Math.abs(v))) throw new BlockError(`${def.path} is declared linear but is not`);
  }));
  return Object.keys(f.outputs).map((_, o) => cols.map((c) => c[o]!));
}

/** Linear model of a linear Block with given parameters (for frequency-domain Analyses). */
export function linearModel(def: BlockDef, overrides: Record<string, number>): { ss: StateSpace; domain: "continuous" | "discrete" } | null {
  const p = parameterValues(def, overrides);
  const f = def.file;
  if (f.kind === "transfer-function") {
    return { ss: tfModel(def, p), domain: f.domain };
  }
  if (f.kind === "state-space") {
    const m = (x: Expr[][], name: string): Matrix => x.map((row) => evalAll(row, p, `${def.path} ${name}`));
    return { ss: { A: m(f.A, "A"), B: m(f.B, "B"), C: m(f.C, "C"), D: m(f.D, "D") }, domain: f.domain };
  }
  return null;
}

function tfModel(def: BlockDef, p: Record<string, number>): StateSpace {
  const f = def.file as Extract<BlockFile, { kind: "transfer-function" }>;
  const num = evalAll(f.numerator, p, `${def.path} numerator`);
  const den = evalAll(f.denominator, p, `${def.path} denominator`);
  try {
    return tf2ss(num, den);
  } catch (e) {
    throw new BlockError(`${def.path}: ${(e as Error).message}`);
  }
}

export function instantiate(def: BlockDef, overrides: Record<string, number>, sampleRateHz: number): BlockRuntime {
  const p = parameterValues(def, overrides);
  const dt = 1 / sampleRateHz;
  const f = def.file;
  switch (f.kind) {
    case "transfer-function":
    case "state-space": {
      const lm = linearModel(def, overrides)!;
      return stateSpaceRuntime(def, lm.ss, lm.domain, dt);
    }
    case "difference-equation":
      return differenceRuntime(def, f.equations, f.inputs, p, dt);
    case "formula":
      return formulaRuntime(def, f.outputs, f.inputs, p);
  }
}

function stateSpaceRuntime(def: BlockDef, ss: StateSpace, domain: "continuous" | "discrete", dt: number): BlockRuntime {
  const n = ss.A.length;
  const feedthrough = ss.D.some((row) => row.some((x) => x !== 0));
  // RK4 is stable for |λ|·h ≲ 2.8; sub-step so stiff continuous Blocks stay accurate.
  const norm = Math.max(0, ...ss.A.map((r) => r.reduce((s, x) => s + Math.abs(x), 0)));
  const sub = domain === "continuous" ? Math.max(1, Math.ceil((norm * dt) / 0.5)) : 1;
  let x = new Array<number>(n).fill(0);
  return {
    inputs: def.inputs,
    outputs: def.outputs,
    feedthrough,
    output: (u) => {
      const cx = n ? matVec(ss.C, x) : ss.D.map(() => 0);
      const du = matVec(ss.D, u);
      return cx.map((v, i) => v + du[i]!);
    },
    update: (u) => {
      if (!n) return;
      if (domain === "discrete") {
        const ax = matVec(ss.A, x);
        const bu = matVec(ss.B, u);
        x = ax.map((v, i) => v + bu[i]!);
      } else {
        for (let k = 0; k < sub; k++) x = rk4Step(ss, x, u, dt / sub);
      }
    },
    reset: () => {
      x = new Array<number>(n).fill(0);
    },
  };
}

interface CompiledDifference {
  outputs: string[];
  signals: Set<string>;
  maxDelay: number;
  feedthrough: boolean;
  /** One per output; scope names are __<signal>_<delay>. */
  compiled: Compiled[];
}

function compileDifference(def: BlockDef, equations: Record<string, string>, inputs: string[]): CompiledDifference {
  const outputs = Object.keys(equations);
  const signals = new Set([...inputs, ...outputs]);
  let maxDelay = 1;
  let feedthrough = false;
  const compiled: Compiled[] = outputs.map((out) => {
    // y[n-2] → __y_2 ; u[n] → __u_0
    const src = equations[out]!.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*n\s*(?:-\s*(\d+))?\s*\]/g, (_, name: string, k?: string) => {
      if (!signals.has(name)) throw new BlockError(`${def.path}: ${name}[…] is neither an input nor an output`);
      const delay = k ? Number(k) : 0;
      if (outputs.includes(name) && delay === 0) throw new BlockError(`${def.path}: ${out} cannot depend on ${name}[n]`);
      if (inputs.includes(name) && delay === 0) feedthrough = true;
      maxDelay = Math.max(maxDelay, delay);
      return `__${name}_${delay}`;
    });
    try {
      return compile(src);
    } catch (e) {
      throw new BlockError(`${def.path} equation ${out}: ${(e as ExprError).message}`);
    }
  });
  return { outputs, signals, maxDelay, feedthrough, compiled };
}

/**
 * Transfer function in z of a linear single-input single-output difference equation,
 * found by probing each delayed term's coefficient.
 */
export function differenceTransferFunction(def: BlockDef, overrides: Record<string, number>): { num: number[]; den: number[] } {
  const f = def.file;
  if (f.kind !== "difference-equation") throw new BlockError(`${def.path} is not a difference equation`);
  if (f.inputs.length !== 1 || Object.keys(f.equations).length !== 1) {
    throw new BlockError(`${def.path}: frequency-domain Analyses support single-input single-output difference equations`);
  }
  const p = parameterValues(def, overrides);
  const d = compileDifference(def, f.equations, f.inputs);
  const [u] = f.inputs as [string];
  const [y] = d.outputs as [string];
  const K = d.maxDelay;
  const zeroScope = () => {
    const sc: Record<string, number> = { ...p, t: 0, dt: 0 };
    for (let k = 0; k <= K; k++) {
      sc[`__${u}_${k}`] = 0;
      sc[`__${y}_${k}`] = 0;
    }
    return sc;
  };
  const eq = d.compiled[0]!;
  const offset = eq(zeroScope());
  if (Math.abs(offset) > 1e-12) throw new BlockError(`${def.path} is not linear (constant term ${offset})`);
  const coef = (name: string) => {
    const sc = zeroScope();
    sc[name] = 1;
    return eq(sc);
  };
  // y[n] = Σ a_k y[n−k] + Σ b_k u[n−k]  ⇒  H(z) = Σ b_k z^{K−k} / (z^K − Σ a_k z^{K−k})
  const num = Array.from({ length: K + 1 }, (_, k) => coef(`__${u}_${k}`));
  const den = Array.from({ length: K + 1 }, (_, k) => (k === 0 ? 1 : -coef(`__${y}_${k}`)));
  return { num, den };
}

function differenceRuntime(
  def: BlockDef,
  equations: Record<string, string>,
  inputs: string[],
  params: Record<string, number>,
  dt: number,
): BlockRuntime {
  const { outputs, signals, maxDelay, feedthrough, compiled } = compileDifference(def, equations, inputs);
  // history[name][k] = value k samples ago (k = 1 … maxDelay)
  let history: Record<string, number[]> = {};
  const clear = () => {
    history = Object.fromEntries([...signals].map((s) => [s, new Array<number>(maxDelay + 1).fill(0)]));
  };
  clear();
  let lastY: number[] = outputs.map(() => 0);
  const scopeFor = (u: number[], t: number) => {
    const scope: Record<string, number> = { ...params, t, dt };
    for (const name of signals) {
      const h = history[name]!;
      for (let k = 1; k <= maxDelay; k++) scope[`__${name}_${k}`] = h[k]!;
    }
    inputs.forEach((name, i) => (scope[`__${name}_0`] = u[i] ?? 0));
    return scope;
  };
  const check = (y: number[]) => {
    for (let i = 0; i < y.length; i++) if (!Number.isFinite(y[i]!)) throw new BlockError(`${def.path}: ${outputs[i]} became ${y[i]}`);
    return y;
  };
  return {
    inputs,
    outputs,
    feedthrough,
    output: (u, t) => {
      try {
        lastY = check(compiled.map((c) => c(scopeFor(u, t))));
      } catch (e) {
        throw e instanceof BlockError ? e : new BlockError(`${def.path}: ${(e as Error).message}`);
      }
      return lastY;
    },
    update: (u) => {
      const shift = (name: string, v: number) => {
        const h = history[name]!;
        for (let k = maxDelay; k > 1; k--) h[k] = h[k - 1]!;
        h[1] = v;
      };
      inputs.forEach((name, i) => shift(name, u[i] ?? 0));
      outputs.forEach((name, i) => shift(name, lastY[i]!));
    },
    reset: () => {
      clear();
      lastY = outputs.map(() => 0);
    },
  };
  void dt;
}

function formulaRuntime(def: BlockDef, exprs: Record<string, string>, inputs: string[], params: Record<string, number>): BlockRuntime {
  const outputs = Object.keys(exprs);
  const compiled = outputs.map((o) => {
    try {
      return compile(exprs[o]!);
    } catch (e) {
      throw new BlockError(`${def.path} output ${o}: ${(e as Error).message}`);
    }
  });
  return {
    inputs,
    outputs,
    feedthrough: true,
    output: (u, t) => {
      const scope: Record<string, number> = { ...params, t };
      inputs.forEach((name, i) => (scope[name] = u[i] ?? 0));
      try {
        return compiled.map((c) => c(scope));
      } catch (e) {
        throw new BlockError(`${def.path}: ${(e as Error).message}`);
      }
    },
    update: () => {},
    reset: () => {},
  };
}

export function sumRuntime(signs: string): BlockRuntime {
  const s = [...signs].map((c) => (c === "-" ? -1 : 1));
  return {
    inputs: s.map((_, i) => `in${i + 1}`),
    outputs: ["out"],
    feedthrough: true,
    output: (u) => [u.reduce((acc, v, i) => acc + s[i]! * v, 0)],
    update: () => {},
    reset: () => {},
  };
}

export function gainRuntime(k: number): BlockRuntime {
  return { inputs: ["u"], outputs: ["y"], feedthrough: true, output: (u) => [k * u[0]!], update: () => {}, reset: () => {} };
}
