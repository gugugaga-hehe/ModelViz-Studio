import type { BlockFile, DiscretizationComparison, DiscretizationRequest, DiscretizationResult, Stimulus, SystemFile } from "@modelviz/protocol";
import { stringify } from "yaml";
import { ProtocolFailure } from "../errors.ts";
import { type BlockDef, BlockError, defineBlock, linearModel, loadBlock, parameterValues } from "./block.ts";
import { discretize, ss2tf } from "./discretize.ts";
import { writeProjectFile } from "./store.ts";
import { stimulusFn } from "./stimulus.ts";
import { type LoadedSystem, SystemEngine } from "./system.ts";

/** Continuous reference responses are simulated this many times faster than the discrete rate. */
const OVERSAMPLE = 20;

async function continuousBlock(projectPath: string, path: string): Promise<BlockDef> {
  let def: BlockDef;
  try {
    def = await loadBlock(projectPath, path);
  } catch (e) {
    throw new ProtocolFailure("invalid_params", (e as Error).message);
  }
  if (def.domain !== "continuous" || !def.linear) {
    throw new ProtocolFailure("invalid_params", `${path} is not a continuous linear Block, so it cannot be discretized`);
  }
  return def;
}

function convert(def: BlockDef, req: Omit<DiscretizationRequest, "save">) {
  let lm;
  try {
    lm = linearModel(def, req.parameters)!;
  } catch (e) {
    throw new ProtocolFailure("invalid_params", (e as BlockError).message);
  }
  const d = discretize(lm.ss, 1 / req.sampleRateHz, req.method, req.prewarpHz);
  const siso = def.inputs.length === 1 && def.outputs.length === 1;
  return { d, tf: siso ? ss2tf(d) : null };
}

/** File contents of the discretized Block; numeric, at the chosen rate. */
function discreteFile(def: BlockDef, req: Omit<DiscretizationRequest, "save">, conv: ReturnType<typeof convert>): BlockFile {
  const values = parameterValues(def, req.parameters);
  const desc = `Discretized from ${def.path} (${req.method}${req.prewarpHz ? `, prewarp ${req.prewarpHz} Hz` : ""}, ${req.sampleRateHz} Hz)${
    Object.keys(values).length ? ` with ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""
  }`;
  if (conv.tf) {
    return {
      kind: "transfer-function",
      description: desc,
      parameters: {},
      domain: "discrete",
      sampleRateHz: req.sampleRateHz,
      numerator: conv.tf.num,
      denominator: conv.tf.den,
      input: def.inputs[0]!,
      output: def.outputs[0]!,
    };
  }
  return {
    kind: "state-space",
    description: desc,
    parameters: {},
    domain: "discrete",
    sampleRateHz: req.sampleRateHz,
    A: conv.d.A,
    B: conv.d.B,
    C: conv.d.C,
    D: conv.d.D,
    inputs: def.inputs,
    outputs: def.outputs,
  };
}

export async function discretizeBlock(projectPath: string, req: DiscretizationRequest): Promise<DiscretizationResult> {
  const def = await continuousBlock(projectPath, req.block);
  const conv = convert(def, req);
  let saved: string | undefined;
  if (req.save) {
    const file = discreteFile(def, req, conv);
    const { description, ...rest } = file;
    await writeProjectFile(projectPath, req.save, `# ${description}\n${stringify(rest)}`);
    saved = req.save;
  }
  return {
    method: req.method,
    sampleRateHz: req.sampleRateHz,
    ...(conv.tf ? { numerator: conv.tf.num, denominator: conv.tf.den } : {}),
    A: conv.d.A,
    B: conv.d.B,
    C: conv.d.C,
    D: conv.d.D,
    ...(saved ? { saved } : {}),
  };
}

/** A one-Block System around a Block definition, driven by input "r". */
function wrap(def: BlockDef, fs: number, overrides: Record<string, number>): LoadedSystem {
  const file: SystemFile = {
    sampleRateHz: fs,
    inputs: ["r"],
    blocks: { g: { block: def.path, parameters: overrides } },
    connections: [{ from: "r", to: `g.${def.inputs[0]}` }],
    outputs: { y: `g.${def.outputs[0]}` },
  };
  return { path: "<memory>", name: "compare", file, defs: new Map([["g", def]]), issues: [] };
}

export async function compareDiscretization(
  projectPath: string,
  req: Omit<DiscretizationRequest, "save"> & { kind: "step" | "impulse" | "stimulus"; stimulus?: Stimulus; durationS: number },
): Promise<DiscretizationComparison> {
  const def = await continuousBlock(projectPath, req.block);
  if (def.inputs.length !== 1 || def.outputs.length !== 1) {
    throw new ProtocolFailure("invalid_params", "Comparison needs a single-input single-output Block");
  }
  const conv = convert(def, req);
  const discreteDef = defineBlock(`${def.path} (${req.method})`, discreteFile(def, req, conv));
  const stim: Stimulus | undefined =
    req.kind === "step" ? { kind: "step", amplitude: 1, startS: 0 } : req.kind === "impulse" ? { kind: "impulse", area: 1 } : req.stimulus;
  if (!stim) throw new ProtocolFailure("invalid_params", 'kind "stimulus" needs a stimulus');

  const fs = req.sampleRateHz;
  const count = Math.round(req.durationS * fs) + 1;
  const drive = stimulusFn(stim, req.durationS, fs);
  const input = Array.from({ length: count }, (_, k) => drive(k, k / fs));
  const discrete = await new SystemEngine(wrap(discreteDef, fs, {})).run(count, (_n, k) => input[k]!);

  // The continuous reference sees the same input: held per sample for steps and pulses
  // (exactly what a sampled system applies), and the true waveform for smooth Stimuli.
  const fine = fs * OVERSAMPLE;
  const held = stim.kind === "step" || stim.kind === "impulse";
  const cont = await new SystemEngine(wrap(def, fine, req.parameters)).run((count - 1) * OVERSAMPLE + 1, (_n, k, t) =>
    held ? input[Math.floor(k / OVERSAMPLE)]! : drive(k, t),
  );
  const continuous = Array.from({ length: count }, (_, k) => cont[0]![k * OVERSAMPLE]!);
  const d = Array.from(discrete[0]!);
  return {
    times: Array.from({ length: count }, (_, k) => k / fs),
    input,
    continuous,
    discrete: d,
    maxAbsError: Math.max(...d.map((v, i) => Math.abs(v - continuous[i]!))),
  };
}
