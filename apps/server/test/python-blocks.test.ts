import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import { describe, expect, it } from "vitest";
import { harness } from "./harness.ts";

const hasUv = spawnSync("uv", ["--version"]).status === 0;
type H = Awaited<ReturnType<typeof harness>>;

/** Project with a ready (dependency-free) Python environment and the given files. */
async function pythonProject(h: H, c: ModelVizClient, files: Record<string, string>) {
  const path = join(h.dir, "py");
  await c.request("project.create", { path, name: "py" });
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(path, rel, ".."), { recursive: true });
    await writeFile(join(path, rel), text);
  }
  const ready = new Promise<void>((resolve, reject) =>
    c.on("python.changed", (s) => (s.state === "ready" ? resolve() : s.state === "failed" ? reject(new Error(s.error)) : undefined)),
  );
  await c.request("python.configure", { dependencies: [] });
  await ready;
  return path;
}

const SATURATION_PY = `
class Block:
    """Gain followed by a symmetric limit."""
    def __init__(self, params, sample_rate):
        self.k = params["K"]
        self.limit = params["limit"]
    def reset(self):
        pass
    def process(self, t, inputs):
        return {"y": [max(-self.limit, min(self.limit, self.k * u)) for u in inputs["u"]]}
`;
const SATURATION = `kind: python
module: python/saturation.py
parameters:
  K: { default: 2 }
  limit: { default: 1 }
`;
const DEADZONE_PY = `
class Block:
    def __init__(self, params, sample_rate):
        self.w = params["width"]
    def process(self, t, inputs):
        out = []
        for u in inputs["u"]:
            out.append(0.0 if abs(u) <= self.w else u - self.w * (1 if u > 0 else -1))
        return {"y": out}
`;
const single = (block: string, fs = 1000) =>
  `sampleRateHz: ${fs}\ninputs: [r]\nblocks:\n  g: { block: ${block} }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n`;
const sine = { kind: "sine" as const, freqHz: 2, amplitude: 2 };

describe.skipIf(!hasUv)("Python Blocks", () => {
  it("runs nonlinear Python Blocks (saturation, dead zone) in Systems", async () => {
    await using h = await harness();
    const c = await h.client();
    await pythonProject(h, c, {
      "python/saturation.py": SATURATION_PY,
      "blocks/sat.yaml": SATURATION,
      "systems/sat.yaml": single("blocks/sat.yaml"),
      "python/deadzone.py": DEADZONE_PY,
      "blocks/dz.yaml": "kind: python\nmodule: python/deadzone.py\nparameters:\n  width: { default: 0.5 }\n",
      "systems/dz.yaml": single("blocks/dz.yaml"),
    });
    expect((await c.request("blocks.list", {})).find((b) => b.path === "blocks/sat.yaml")).toMatchObject({
      kind: "python",
      domain: "python",
      linear: false,
      inputs: ["u"],
      outputs: ["y"],
    });
    const sat = await c.request("analysis.time", { system: "systems/sat.yaml", kind: "stimulus", stimulus: sine, durationS: 1 });
    sat.series.y!.forEach((y, i) => expect(y).toBeCloseTo(Math.max(-1, Math.min(1, 2 * sat.series.r![i]!)), 12));
    const dz = await c.request("analysis.time", { system: "systems/dz.yaml", kind: "stimulus", stimulus: sine, durationS: 1 });
    dz.series.y!.forEach((y, i) => {
      const u = dz.series.r![i]!;
      expect(y).toBeCloseTo(Math.abs(u) <= 0.5 ? 0 : u - 0.5 * Math.sign(u), 12);
    });
    // Block Parameter overrides reach Python
    const wide = await c.request("analysis.time", {
      system: "systems/sat.yaml",
      kind: "stimulus",
      stimulus: sine,
      durationS: 1,
      parameters: { g: { limit: 3 } },
    });
    expect(Math.max(...wide.series.y!)).toBeCloseTo(3, 6);
  }, 120000);

  it("matches an equivalent declarative Block inside a feedback loop", async () => {
    await using h = await harness();
    const c = await h.client();
    const plant = "kind: transfer-function\ndomain: continuous\nnumerator: [1]\ndenominator: [0.05, 1, 0]\n";
    await pythonProject(h, c, {
      "python/saturation.py": SATURATION_PY,
      "blocks/sat.yaml": SATURATION,
      "blocks/sat-formula.yaml": "kind: formula\nparameters:\n  K: { default: 2 }\n  limit: { default: 1 }\noutputs:\n  y: sat(K*u, -limit, limit)\n",
      "blocks/plant.yaml": plant,
    });
    for (const [name, ctl] of [["py", "blocks/sat.yaml"], ["decl", "blocks/sat-formula.yaml"]] as const) {
      await c.request("system.fromLoopTemplate", { name, sampleRateHz: 1000, controller: ctl, plant: "blocks/plant.yaml" });
    }
    const t0 = Date.now();
    const py = await c.request("analysis.time", { system: "systems/py.yaml", kind: "step", durationS: 2 });
    const elapsed = Date.now() - t0;
    const decl = await c.request("analysis.time", { system: "systems/decl.yaml", kind: "step", durationS: 2 });
    for (const out of ["y", "u", "e"]) {
      py.series[out]!.forEach((v, i) => expect(v).toBeCloseTo(decl.series[out]![i]!, 12));
    }
    // the controller really saturates in this loop
    expect(Math.max(...py.series.u!)).toBeCloseTo(1, 12);
    // per-sample Python calls inside a loop stay practical
    expect(elapsed).toBeLessThan(10000);
  }, 120000);

  it("reports Python exceptions with file and line", async () => {
    await using h = await harness();
    const c = await h.client();
    await pythonProject(h, c, {
      "python/bad.py": "class Block:\n    def __init__(self, params, sample_rate):\n        pass\n    def process(self, t, inputs):\n        return {'y': [1 / 0 for _ in t]}\n",
      "blocks/bad.yaml": "kind: python\nmodule: python/bad.py\n",
      "systems/bad.yaml": single("blocks/bad.yaml"),
      "python/short.py": "class Block:\n    def __init__(self, params, sample_rate):\n        pass\n    def process(self, t, inputs):\n        return {'y': [0.0]}\n",
      "blocks/short.yaml": "kind: python\nmodule: python/short.py\n",
      "systems/short.yaml": single("blocks/short.yaml"),
      "blocks/missing.yaml": "kind: python\nmodule: python/nope.py\n",
    });
    await expect(c.request("analysis.time", { system: "systems/bad.yaml", kind: "step", durationS: 0.1 })).rejects.toThrow(
      /blocks\/bad\.yaml bad\.py:5: ZeroDivisionError/,
    );
    await expect(c.request("analysis.time", { system: "systems/short.yaml", kind: "step", durationS: 0.1 })).rejects.toThrow(
      /output 'y' has 1 values for 101 samples/,
    );
    expect((await c.request("blocks.list", {})).find((b) => b.path === "blocks/missing.yaml")?.error).toMatch(/Python module not found/);
  }, 120000);

  it("marks Python Blocks linear or nonlinear and has no analytic model for them", async () => {
    await using h = await harness();
    const c = await h.client();
    await pythonProject(h, c, {
      "python/gain.py": "class Block:\n    def __init__(self, p, r):\n        pass\n    def process(self, t, inputs):\n        return {'y': [3 * u for u in inputs['u']]}\n",
      "blocks/gain.yaml": "kind: python\nmodule: python/gain.py\nlinear: true\n",
      "systems/gain.yaml": single("blocks/gain.yaml"),
    });
    expect((await c.request("blocks.list", {}))[0]).toMatchObject({ linear: true, domain: "python" });
    await expect(c.request("analysis.frequency", { system: "systems/gain.yaml" })).rejects.toThrow(/Python Block, which has no analytic model/);
  });

  it("needs the Project's Python environment", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = join(h.dir, "nopy");
    await c.request("project.create", { path, name: "nopy" });
    await mkdir(join(path, "python"));
    await mkdir(join(path, "blocks"));
    await mkdir(join(path, "systems"));
    await writeFile(join(path, "python/saturation.py"), SATURATION_PY);
    await writeFile(join(path, "blocks/sat.yaml"), SATURATION);
    await writeFile(join(path, "systems/sat.yaml"), single("blocks/sat.yaml"));
    await c.request("project.open", { path });
    await expect(c.request("analysis.time", { system: "systems/sat.yaml", kind: "step", durationS: 0.1 })).rejects.toThrow(
      /Python environment is not ready/,
    );
  });
});
