import type { MappingInfo, ParameterMapping, PushEntry, PushOutcome } from "@modelviz/protocol";
import { type ParameterClient, representable, stored } from "./device-parameters.ts";
import { ProtocolFailure } from "./errors.ts";
import { type LoadedSystem, loadSystem } from "./model/system.ts";

/** A preview can be confirmed for this long; after that the Device values shown may be stale. */
const PREVIEW_TTL_MS = 10 * 60 * 1000;

/** Looks up each mapping's Block Parameter value: the System Block's override, else the Block default. */
export async function resolveMappings(projectPath: string, mappings: ParameterMapping[], devices: Set<string>): Promise<MappingInfo[]> {
  const systems = new Map<string, LoadedSystem>();
  const out: MappingInfo[] = [];
  for (const m of mappings) {
    let sys = systems.get(m.system);
    if (!sys) {
      sys = await loadSystem(projectPath, m.system);
      systems.set(m.system, sys);
    }
    const issue = (msg: string) => out.push({ ...m, issue: msg });
    if (!devices.has(m.device)) {
      issue(`Unknown Device ${m.device}`);
      continue;
    }
    if (!sys.file) {
      issue(sys.issues[0]?.message ?? `System ${m.system} cannot be read`);
      continue;
    }
    const block = sys.file.blocks[m.block];
    if (!block) {
      issue(`System ${sys.name} has no Block ${m.block}`);
      continue;
    }
    const def = sys.defs.get(m.block);
    const spec = def?.parameters[m.parameter];
    if (!("block" in block) || !def || !spec) {
      issue(def || !("block" in block) ? `${m.block} has no Block Parameter ${m.parameter}` : `${m.block}: Block cannot be loaded`);
      continue;
    }
    out.push({ ...m, blockValue: block.parameters[m.parameter] ?? spec.default });
  }
  return out;
}

/** Throws unless every Device Parameter is the target of at most one mapping. */
export function checkMappings(mappings: ParameterMapping[]): void {
  const seen = new Set<string>();
  for (const m of mappings) {
    const key = `${m.device}/${m.deviceParameter}`;
    if (seen.has(key)) throw new ProtocolFailure("invalid_params", `Device Parameter ${key} is mapped more than once`);
    seen.add(key);
  }
}

interface Preview {
  device: string;
  entries: PushEntry[];
  at: number;
}

const same = (a: ParameterMapping, b: ParameterMapping) =>
  a.system === b.system && a.block === b.block && a.parameter === b.parameter && a.device === b.device && a.deviceParameter === b.deviceParameter;

/**
 * Push in two steps (ADR-0008): `preview` only reads from the Device; `apply` writes exactly
 * what a preview showed, once, after the user confirmed it. This is the only code path that
 * writes Block Parameter values to the Device.
 */
export class PushService {
  private readonly previews = new Map<string, Preview>();
  private next = 1;

  clear(): void {
    this.previews.clear();
  }

  async preview(device: string, mappings: MappingInfo[], client: ParameterClient): Promise<{ id: string; device: string; entries: PushEntry[] }> {
    const entries: PushEntry[] = [];
    for (const info of mappings.filter((m) => m.device === device)) {
      const { blockValue, issue, ...mapping } = info;
      const proposed = blockValue ?? null;
      if (issue || proposed === null) {
        entries.push({ mapping, proposed, current: null, status: "unavailable", message: issue ?? "No Block Parameter value" });
        continue;
      }
      let current;
      try {
        current = await client.read(mapping.deviceParameter);
      } catch (e) {
        entries.push({ mapping, proposed, current: null, status: "unavailable", message: (e as Error).message });
        continue;
      }
      if (!representable(current.type, proposed)) {
        entries.push({ mapping, proposed, current, status: "invalid", message: `${proposed} cannot be stored in a ${current.type} Device Parameter` });
        continue;
      }
      entries.push({ mapping, proposed, current, status: stored(current.type, proposed) === current.value ? "unchanged" : "changed" });
    }
    const id = `push-${this.next++}`;
    this.previews.set(id, { device, entries, at: Date.now() });
    return { id, device, entries };
  }

  /** Takes a preview out of the store; each preview is applied at most once. */
  take(id: string): Preview {
    const p = this.previews.get(id);
    this.previews.delete(id);
    if (!p) throw new ProtocolFailure("not_found", `No Push preview ${id}: it was already applied or the Project changed`);
    if (Date.now() - p.at > PREVIEW_TTL_MS) throw new ProtocolFailure("conflict", "The Push preview has expired; review the differences again");
    return p;
  }

  async apply(p: Preview, current: MappingInfo[], client: ParameterClient): Promise<PushOutcome[]> {
    // the user confirmed specific values: if a Block Parameter moved since, they must look again
    for (const e of p.entries.filter((x) => x.status === "changed")) {
      const now = current.find((m) => same(m, e.mapping));
      if (now?.blockValue !== e.proposed) {
        throw new ProtocolFailure("conflict", `Block Parameter ${e.mapping.block}.${e.mapping.parameter} changed since the preview; review the differences again`);
      }
    }
    const results: PushOutcome[] = [];
    for (const e of p.entries) {
      if (e.status !== "changed") {
        results.push({ mapping: e.mapping, proposed: e.proposed, outcome: "not_written", message: e.message ?? e.status });
        continue;
      }
      try {
        const w = await client.write(e.mapping.deviceParameter, e.proposed!);
        results.push({ mapping: e.mapping, proposed: e.proposed, outcome: w.accepted ? "acknowledged" : "refused", parameter: w.parameter });
      } catch (err) {
        results.push({ mapping: e.mapping, proposed: e.proposed, outcome: "failed", message: (err as Error).message });
      }
    }
    return results;
  }
}
