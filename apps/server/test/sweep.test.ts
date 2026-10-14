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
}

const SO = `kind: transfer-function
domain: continuous
parameters:
  wn: { default: 20 }
  zeta: { default: 0.3, min: 0, max: 1 }
numerator: ["wn^2"]
denominator: [1, "2*zeta*wn", "wn^2"]
`;
const single = (block: string, fs = 2000) =>
  `sampleRateHz: ${fs}\ninputs: [r]\nblocks:\n  g: { block: ${block} }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n`;
const K = "kind: formula\nparameters: { K: { default: 1 } }\noutputs:\n  y: K*u\nlinear: true\n";
const PLANT = `kind: transfer-function
domain: continuous
parameters:
  p: { default: 2 }
numerator: [1]
denominator: [1, "1+p", p, 0]
`;

describe("Parameter Sweeps", () => {
  it("sweeps one Block Parameter and records step and frequency Metrics", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/so.yaml": SO, "systems/so.yaml": single("blocks/so.yaml") });
    const progress: number[] = [];
    c.on("analysis.progress", (p) => p.id === "s1" && progress.push(p.done));
    const r = await c.request("analysis.sweep", {
      id: "s1",
      system: "systems/so.yaml",
      axes: [{ block: "g", parameter: "zeta", from: 0.1, to: 0.7, steps: 7 }],
      metrics: { output: "y", step: ["overshootPercent"], frequency: ["peakGainDb"], durationS: 3 },
    });
    const zetas = r.axes[0]!.values;
    zetas.forEach((z, i) => expect(z).toBeCloseTo(0.1 + 0.1 * i, 12));
    const os = r.values.overshootPercent as number[];
    zetas.forEach((z, i) => expect(os[i]!).toBeCloseTo(100 * Math.exp((-z * Math.PI) / Math.sqrt(1 - z * z)), 1));
    // resonance 1/(2ζ√(1−ζ²)) exists only for ζ < 1/√2
    const peak = r.values.peakGainDb as number[];
    expect(peak[0]!).toBeCloseTo(20 * Math.log10(1 / (2 * 0.1 * Math.sqrt(0.99))), 1);
    expect(progress.at(-1)).toBe(7);
  });

  it("sweeps two Block Parameters into a grid of loop Metrics", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/k.yaml": K, "blocks/plant.yaml": PLANT });
    await c.request("system.fromLoopTemplate", { name: "loop", sampleRateHz: 1000, controller: "blocks/k.yaml", plant: "blocks/plant.yaml" });
    const r = await c.request("analysis.sweep", {
      id: "s2",
      system: "systems/loop.yaml",
      axes: [
        { block: "controller", parameter: "K", from: 0.5, to: 4, steps: 4, scale: "log" },
        { block: "plant", parameter: "p", from: 1, to: 4, steps: 4 },
      ],
      metrics: { output: "y", loop: ["gainMarginDb"], openLoopAt: "plant.u" },
    });
    // L = K / (s (s+1) (s+p)): phase crossover at ω = √p, so GM = 20·log10( √p·√(p+1)·√(p+p²) / K )
    const gm = r.values.gainMarginDb as number[][];
    expect(gm).toHaveLength(4);
    r.axes[0]!.values.forEach((k, i) =>
      r.axes[1]!.values.forEach((p, j) => {
        const w = Math.sqrt(p);
        expect(gm[i]![j]!).toBeCloseTo(20 * Math.log10((w * Math.hypot(w, 1) * Math.hypot(w, p)) / k), 4);
      }),
    );
    expect(r.axes[0]!.values[3]).toBeCloseTo(4, 12);
  });

  it("reports unstable or undefined points as null", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/k.yaml": K, "blocks/plant.yaml": PLANT });
    await c.request("system.fromLoopTemplate", { name: "loop", sampleRateHz: 1000, controller: "blocks/k.yaml", plant: "blocks/plant.yaml" });
    const r = await c.request("analysis.sweep", {
      id: "s3",
      system: "systems/loop.yaml",
      axes: [{ block: "controller", parameter: "K", from: 1, to: 50, steps: 2 }],
      metrics: { output: "y", step: ["settlingTimeS"], durationS: 40 },
    });
    // K = 1 settles in ≈ 12 s (dominant poles −0.34 ± 0.56j); K = 50 > 6 destabilises the loop
    const st = r.values.settlingTimeS as (number | null)[];
    expect(st[0]).not.toBeNull();
    expect(st[1]).toBeNull();
  });

  it("can be cancelled while running", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/so.yaml": SO, "systems/so.yaml": single("blocks/so.yaml", 10000) });
    const started = new Promise<void>((r) => c.on("analysis.progress", (p) => p.id === "big" && r()));
    const sweep = c.request("analysis.sweep", {
      id: "big",
      system: "systems/so.yaml",
      axes: [
        { block: "g", parameter: "zeta", from: 0.1, to: 0.9, steps: 100 },
        { block: "g", parameter: "wn", from: 5, to: 50, steps: 100 },
      ],
      metrics: { output: "y", step: ["overshootPercent"], durationS: 5 },
    });
    await started;
    const t0 = Date.now();
    expect(await c.request("analysis.cancel", { id: "big" })).toEqual({ cancelled: true });
    await expect(sweep).rejects.toMatchObject({ code: "cancelled" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await c.request("analysis.cancel", { id: "big" })).toEqual({ cancelled: false });
  });

  it("validates axes and Metrics", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/so.yaml": SO, "systems/so.yaml": single("blocks/so.yaml") });
    const base = { id: "v", system: "systems/so.yaml", metrics: { output: "y", step: ["overshootPercent" as const] } };
    await expect(c.request("analysis.sweep", { ...base, axes: [{ block: "nope", parameter: "x", from: 0, to: 1, steps: 2 }] })).rejects.toThrow(/no Block nope/);
    await expect(c.request("analysis.sweep", { ...base, axes: [{ block: "g", parameter: "x", from: 0, to: 1, steps: 2 }] })).rejects.toThrow(/no Block Parameter x/);
    await expect(
      c.request("analysis.sweep", { ...base, axes: [{ block: "g", parameter: "wn", from: 0, to: 1, steps: 2, scale: "log" }] }),
    ).rejects.toThrow(/positive bounds/);
    const systems = await c.request("systems.list", {});
    expect(systems[0]!.parameters.g).toMatchObject({ zeta: { default: 0.3, min: 0, max: 1 } });
  });
});
