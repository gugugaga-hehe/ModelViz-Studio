import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import type { BlockInfo, SystemInfo } from "@modelviz/protocol";
import { stringify } from "yaml";
import { ProtocolFailure } from "../errors.ts";
import { loadBlock } from "./block.ts";
import { loadSystem } from "./system.ts";

export const BLOCKS_DIR = "blocks";
export const SYSTEMS_DIR = "systems";

type FileKind = "frame-format" | "dialect" | "block" | "system" | "other";
const EDITABLE = /\.(ya?ml|xml)$/;

/** Resolves a Project-relative path and refuses anything outside the Project. */
export function projectFile(projectPath: string, rel: string): string {
  const abs = normalize(resolve(projectPath, rel));
  if (abs !== projectPath && !abs.startsWith(projectPath + sep)) {
    throw new ProtocolFailure("invalid_params", `Path is outside the Project: ${rel}`);
  }
  return abs;
}

function kindOf(rel: string): FileKind {
  if (rel.startsWith(`${BLOCKS_DIR}/`)) return "block";
  if (rel.startsWith(`${SYSTEMS_DIR}/`)) return "system";
  if (rel.endsWith(".xml")) return "dialect";
  if (rel.startsWith("frame-formats/")) return "frame-format";
  return "other";
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".") || e.name === "recordings" || e.name === "imports" || e.name === "node_modules") continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, rel, out);
    else if (EDITABLE.test(e.name)) out.push(rel);
  }
}

export async function listFiles(projectPath: string): Promise<{ path: string; kind: FileKind }[]> {
  const out: string[] = [];
  await walk(projectPath, "", out);
  return out.sort().map((path) => ({ path, kind: kindOf(path) }));
}

export async function readProjectFile(projectPath: string, rel: string): Promise<string> {
  const abs = projectFile(projectPath, rel);
  try {
    return await readFile(abs, "utf8");
  } catch {
    throw new ProtocolFailure("not_found", `No such file: ${rel}`);
  }
}

export async function writeProjectFile(projectPath: string, rel: string, content: string): Promise<void> {
  const abs = projectFile(projectPath, rel);
  if (!EDITABLE.test(abs)) throw new ProtocolFailure("invalid_params", "Only .yaml, .yml and .xml files can be edited");
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function filesIn(projectPath: string, dir: string): Promise<string[]> {
  const names = await readdir(join(projectPath, dir)).catch(() => [] as string[]);
  return names.filter((n) => /\.ya?ml$/.test(n)).sort().map((n) => `${dir}/${n}`);
}

export async function listBlocks(projectPath: string): Promise<BlockInfo[]> {
  const out: BlockInfo[] = [];
  for (const path of await filesIn(projectPath, BLOCKS_DIR)) {
    try {
      const d = await loadBlock(projectPath, path);
      out.push({
        path,
        kind: d.file.kind,
        ...(d.domain !== "memoryless" ? { domain: d.domain } : {}),
        linear: d.linear,
        inputs: d.inputs,
        outputs: d.outputs,
        parameters: d.parameters,
      });
    } catch (e) {
      out.push({ path, inputs: [], outputs: [], parameters: {}, error: (e as Error).message });
    }
  }
  return out;
}

export async function listSystems(projectPath: string): Promise<SystemInfo[]> {
  const out: SystemInfo[] = [];
  for (const path of await filesIn(projectPath, SYSTEMS_DIR)) {
    const s = await loadSystem(projectPath, path);
    out.push({
      path,
      name: s.name,
      ...(s.file ? { sampleRateHz: s.file.sampleRateHz } : {}),
      inputs: s.file?.inputs ?? [],
      outputs: s.file ? Object.keys(s.file.outputs) : [],
      ports: s.file ? s.file.connections.map((c) => c.to).filter((p, i, a) => a.indexOf(p) === i) : [],
      issues: s.issues,
    });
  }
  return out;
}

/**
 * Writes a System for the standard feedback loop:
 *   r → error = r − feedback → controller → plant → [sensor] → feedback
 * The result is an ordinary System graph (ADR-0004).
 */
export async function writeLoopTemplate(
  projectPath: string,
  name: string,
  sampleRateHz: number,
  controller: string,
  plant: string,
  sensor: string | undefined,
): Promise<string> {
  const rel = `${SYSTEMS_DIR}/${name}.yaml`;
  const abs = projectFile(projectPath, rel);
  if (await stat(abs).then(() => true, () => false)) throw new ProtocolFailure("already_exists", `System ${rel} already exists`);
  const siso = async (path: string, role: string) => {
    let d;
    try {
      d = await loadBlock(projectPath, path);
    } catch (e) {
      throw new ProtocolFailure("invalid_system", `${role}: ${(e as Error).message}`);
    }
    if (d.inputs.length !== 1 || d.outputs.length !== 1) {
      throw new ProtocolFailure("invalid_system", `${role} ${path} must have exactly one input and one output`);
    }
    return { in: d.inputs[0]!, out: d.outputs[0]! };
  };
  const c = await siso(controller, "Controller");
  const p = await siso(plant, "Plant");
  const s = sensor ? await siso(sensor, "Sensor filter") : null;
  const feedback = s ? `sensor.${s.out}` : `plant.${p.out}`;
  const doc = {
    description: "Feedback loop created from the Loop Template",
    sampleRateHz,
    inputs: ["r"],
    blocks: {
      error: { kind: "sum", signs: "+-" },
      controller: { block: controller },
      plant: { block: plant },
      ...(s ? { sensor: { block: sensor! } } : {}),
    },
    connections: [
      { from: "r", to: "error.in1" },
      { from: feedback, to: "error.in2" },
      { from: "error.out", to: `controller.${c.in}` },
      { from: `controller.${c.out}`, to: `plant.${p.in}` },
      ...(s ? [{ from: `plant.${p.out}`, to: `sensor.${s.in}` }] : []),
    ],
    outputs: {
      y: `plant.${p.out}`,
      u: `controller.${c.out}`,
      e: "error.out",
      ...(s ? { ym: `sensor.${s.out}` } : {}),
    },
  };
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `# r → error = r − feedback → controller → plant${s ? " → sensor" : ""} → feedback\n${stringify(doc)}`);
  return relative(projectPath, abs).split(sep).join("/");
}
