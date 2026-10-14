import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import { describe, expect, it } from "vitest";
import { harness } from "./harness.ts";

type H = Awaited<ReturnType<typeof harness>>;

async function modelProject(h: H, c: ModelVizClient, files: Record<string, string>) {
  const path = join(h.dir, "model");
  await c.request("project.create", { path, name: "model" });
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(path, rel, ".."), { recursive: true });
    await writeFile(join(path, rel), text);
  }
  await c.request("project.open", { path });
  return path;
}

const SO = `kind: transfer-function
domain: continuous
numerator: [400]
denominator: [1, 12, 400]
`;
const single = (block: string, fs = 1000) =>
  `sampleRateHz: ${fs}\ninputs: [r]\nblocks:\n  g: { block: ${block} }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n`;
const SAT = "kind: formula\nparameters:\n  K: { default: 4 }\n  limit: { default: 1 }\noutputs:\n  y: sat(K*u, -limit, limit)\n";
const PLANT = "kind: transfer-function\ndomain: continuous\nnumerator: [1]\ndenominator: [0.05, 1, 0]\n";

/** Magnitude/phase at index i of output y. */
const at = (r: { responses: Record<string, { magnitudeDb: number[]; phaseDeg: number[] }> }, o: string, i: number) => ({
  mag: r.responses[o]!.magnitudeDb[i]!,
  ph: r.responses[o]!.phaseDeg[i]!,
});

describe("measured Frequency Response", () => {
  it("agrees with the analytic response of a linear continuous System", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/so.yaml": SO, "systems/so.yaml": single("blocks/so.yaml") });
    const grid = { system: "systems/so.yaml", fMinHz: 1, fMaxHz: 50, points: 12 };
    const measured = await c.request("analysis.frequency", { ...grid, method: "measured" });
    const analytic = await c.request("analysis.frequency", { ...grid, method: "analytic" });
    expect(measured).toMatchObject({ method: "measured", domain: "continuous" });
    expect(analytic.method).toBe("analytic");
    expect(measured.frequencies).toEqual(analytic.frequencies);
    measured.frequencies.forEach((_, i) => {
      expect(Math.abs(at(measured, "y", i).mag - at(analytic, "y", i).mag)).toBeLessThan(0.1);
      expect(Math.abs(at(measured, "y", i).ph - at(analytic, "y", i).ph)).toBeLessThan(1);
    });
  }, 60000);

  it("matches the analytic response exactly for discrete Systems", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/d.yaml": "kind: transfer-function\ndomain: discrete\nsampleRateHz: 200\nnumerator: [0.1, 0]\ndenominator: [1, -0.9]\n",
      "systems/d.yaml": single("blocks/d.yaml", 200),
    });
    const grid = { system: "systems/d.yaml", fMinHz: 1, fMaxHz: 40, points: 8 };
    const measured = await c.request("analysis.frequency", { ...grid, method: "measured" });
    const analytic = await c.request("analysis.frequency", { ...grid, method: "analytic" });
    expect(measured.domain).toBe("discrete");
    measured.frequencies.forEach((_, i) => {
      // sampled simulation and z-domain model coincide: only transient residue remains
      expect(Math.abs(at(measured, "y", i).mag - at(analytic, "y", i).mag)).toBeLessThan(1e-3);
      expect(Math.abs(at(measured, "y", i).ph - at(analytic, "y", i).ph)).toBeLessThan(1e-2);
    });
  }, 60000);

  it("is chosen automatically for nonlinear Systems and depends on amplitude", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/sat.yaml": SAT, "blocks/plant.yaml": PLANT });
    await c.request("system.fromLoopTemplate", { name: "loop", sampleRateHz: 1000, controller: "blocks/sat.yaml", plant: "blocks/plant.yaml" });
    expect((await c.request("systems.list", {}))[0]!.linear).toBe(false);
    await expect(c.request("analysis.frequency", { system: "systems/loop.yaml", method: "analytic" })).rejects.toMatchObject({
      code: "invalid_system",
    });
    const grid = { system: "systems/loop.yaml", fMinHz: 1, fMaxHz: 30, points: 6 };
    const small = await c.request("analysis.frequency", { ...grid, amplitude: 0.05 });
    const large = await c.request("analysis.frequency", { ...grid, amplitude: 5 });
    expect(small.method).toBe("measured");
    // large signals saturate the controller: the closed loop gets slower (less gain at higher frequency)
    const last = small.frequencies.length - 1;
    expect(at(large, "y", last).mag).toBeLessThan(at(small, "y", last).mag - 3);
  }, 120000);

  it("measures loop transfer and margins of a linear loop close to the analytic ones", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/k.yaml": "kind: formula\nparameters: { K: { default: 1 } }\noutputs:\n  y: K*u\nlinear: true\n",
      "blocks/plant.yaml": "kind: transfer-function\ndomain: continuous\nnumerator: [2000]\ndenominator: [1, 30, 200, 0]\n",
    });
    await c.request("system.fromLoopTemplate", { name: "loop", sampleRateHz: 2000, controller: "blocks/k.yaml", plant: "blocks/plant.yaml" });
    // gain crossover ≈ 1.19 Hz (PM ≈ 32.6°), phase crossover ≈ 2.25 Hz (GM ≈ 9.5 dB): both inside the grid
    const grid = { system: "systems/loop.yaml", openLoopAt: "plant.u", fMinHz: 0.5, fMaxHz: 5, points: 12 };
    const m = await c.request("analysis.frequency", { ...grid, method: "measured" });
    const a = await c.request("analysis.frequency", { ...grid, method: "analytic" });
    expect(a.loop!.phaseMarginDeg).toBeCloseTo(32.6, 0);
    expect(a.loop!.gainMarginDb).toBeCloseTo(9.5, 0);
    expect(Math.abs(m.loop!.phaseMarginDeg! - a.loop!.phaseMarginDeg!)).toBeLessThan(2);
    expect(Math.abs(m.loop!.gainMarginDb! - a.loop!.gainMarginDb!)).toBeLessThan(0.5);
  }, 120000);

  it("reports progress and can be cancelled", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/so.yaml": SO, "systems/so.yaml": single("blocks/so.yaml") });
    const started = new Promise<void>((r) => c.on("analysis.progress", (p) => p.id === "fr" && r()));
    const run = c.request("analysis.frequency", { system: "systems/so.yaml", method: "measured", fMinHz: 0.05, fMaxHz: 100, points: 40, id: "fr" });
    await started;
    await c.request("analysis.cancel", { id: "fr" });
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
  }, 60000);
});

describe.skipIf(spawnSync("uv", ["--version"]).status !== 0)("measured response with Python Blocks", () => {
  it("measures Systems containing Python Blocks", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "python/gain.py": "class Block:\n    def __init__(self, p, r):\n        pass\n    def process(self, t, inputs):\n        return {'y': [0.5 * u for u in inputs['u']]}\n",
      "blocks/gain.yaml": "kind: python\nmodule: python/gain.py\n",
      "systems/g.yaml": single("blocks/gain.yaml"),
    });
    const ready = new Promise<void>((resolve) => c.on("python.changed", (s) => s.state === "ready" && resolve()));
    await c.request("python.configure", { dependencies: [] });
    await ready;
    const r = await c.request("analysis.frequency", { system: "systems/g.yaml", fMinHz: 1, fMaxHz: 50, points: 4 });
    expect(r).toMatchObject({ method: "measured", domain: "discrete" });
    for (const m of r.responses.y!.magnitudeDb) expect(m).toBeCloseTo(20 * Math.log10(0.5), 3);
  }, 120000);
});
