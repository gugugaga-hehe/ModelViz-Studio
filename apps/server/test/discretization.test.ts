import { mkdir, readFile, writeFile } from "node:fs/promises";
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

const LAG = "kind: transfer-function\ndomain: continuous\nparameters:\n  tau: { default: 0.1 }\nnumerator: [1]\ndenominator: [tau, 1]\n";
const INTEGRATOR = "kind: transfer-function\ndomain: continuous\nnumerator: [1]\ndenominator: [1, 0]\n";
const SECOND = "kind: transfer-function\ndomain: continuous\nparameters:\n  wn: { default: 30 }\n  zeta: { default: 0.2 }\nnumerator: ['wn^2']\ndenominator: [1, '2*zeta*wn', 'wn^2']\n";

const close = (a: number[], b: number[], tol = 1e-12) => {
  expect(a).toHaveLength(b.length);
  a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(tol));
};

describe("Discretization", () => {
  it("matches the reference ZOH and Tustin coefficients of a first-order lag", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/lag.yaml": LAG });
    const T = 0.01;
    const tau = 0.1;
    const zoh = await c.request("block.discretize", { block: "blocks/lag.yaml", method: "zoh", sampleRateHz: 100 });
    const a = Math.exp(-T / tau);
    close(zoh.numerator!, [0, 1 - a]);
    close(zoh.denominator!, [1, -a]);

    const tus = await c.request("block.discretize", { block: "blocks/lag.yaml", method: "tustin", sampleRateHz: 100 });
    const k = T / (2 * tau + T);
    close(tus.numerator!, [k, k]);
    close(tus.denominator!, [1, -(2 * tau - T) / (2 * tau + T)]);

    // Block Parameter values are honoured
    const slow = await c.request("block.discretize", { block: "blocks/lag.yaml", method: "zoh", sampleRateHz: 100, parameters: { tau: 1 } });
    close(slow.denominator!, [1, -Math.exp(-T)]);
  });

  it("matches the reference coefficients of an integrator", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/int.yaml": INTEGRATOR });
    const zoh = await c.request("block.discretize", { block: "blocks/int.yaml", method: "zoh", sampleRateHz: 1000 });
    close(zoh.numerator!, [0, 0.001]);
    close(zoh.denominator!, [1, -1]);
    const tus = await c.request("block.discretize", { block: "blocks/int.yaml", method: "tustin", sampleRateHz: 1000 });
    close(tus.numerator!, [0.0005, 0.0005]);
    close(tus.denominator!, [1, -1]);
  });

  it("maps poles by z = e^{sT} (ZOH) and preserves DC gain for a second-order Plant", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/so.yaml": SECOND });
    const T = 1 / 200;
    const r = await c.request("block.discretize", { block: "blocks/so.yaml", method: "zoh", sampleRateHz: 200 });
    const wn = 30;
    const z = 0.2;
    const re = Math.exp(-z * wn * T);
    const wd = wn * Math.sqrt(1 - z * z);
    // (z − p)(z − p̄) = z² − 2 Re(p) z + |p|²
    close(r.denominator!, [1, -2 * re * Math.cos(wd * T), re * re], 1e-12);
    const dc = r.numerator!.reduce((s, x) => s + x, 0) / r.denominator!.reduce((s, x) => s + x, 0);
    expect(dc).toBeCloseTo(1, 12);
  });

  it("prewarps Tustin so the frequency response matches at the chosen frequency", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/lag.yaml": LAG });
    const fs = 100;
    const f = 20;
    const evalAt = (num: number[], den: number[], w: number) => {
      // H(e^{jωT})
      const zr = Math.cos(w / fs);
      const zi = Math.sin(w / fs);
      const poly = (p: number[]) => {
        let re = 0;
        let im = 0;
        for (const coef of p) [re, im] = [re * zr - im * zi + coef, re * zi + im * zr];
        return [re, im] as const;
      };
      const [nr, ni] = poly(num);
      const [dr, di] = poly(den);
      return Math.hypot(nr, ni) / Math.hypot(dr, di);
    };
    const w = 2 * Math.PI * f;
    const analog = 1 / Math.hypot(1, w * 0.1);
    const plain = await c.request("block.discretize", { block: "blocks/lag.yaml", method: "tustin", sampleRateHz: fs });
    const warped = await c.request("block.discretize", { block: "blocks/lag.yaml", method: "tustin", sampleRateHz: fs, prewarpHz: f });
    expect(Math.abs(evalAt(warped.numerator!, warped.denominator!, w) - analog)).toBeLessThan(1e-12);
    expect(Math.abs(evalAt(plain.numerator!, plain.denominator!, w) - analog)).toBeGreaterThan(1e-3);
  });

  it("overlays continuous and discretized responses", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/so.yaml": SECOND });
    // ZOH is exact for a step: the discrete samples lie on the continuous response
    const zoh = await c.request("analysis.discretization", { block: "blocks/so.yaml", method: "zoh", sampleRateHz: 200, kind: "step", durationS: 1 });
    expect(zoh.times).toHaveLength(201);
    expect(zoh.maxAbsError).toBeLessThan(1e-6);
    // Tustin is not exact for a held step (it assumes a ramp between samples); the error
    // shrinks in proportion to the sample period
    const slow = await c.request("analysis.discretization", { block: "blocks/so.yaml", method: "tustin", sampleRateHz: 100, kind: "step", durationS: 1 });
    const fast = await c.request("analysis.discretization", { block: "blocks/so.yaml", method: "tustin", sampleRateHz: 1000, kind: "step", durationS: 1 });
    expect(slow.maxAbsError).toBeGreaterThan(1e-3);
    expect(fast.maxAbsError).toBeLessThan(slow.maxAbsError / 5);
    // a smooth Stimulus is compared against the true continuous input
    const sine = await c.request("analysis.discretization", {
      block: "blocks/so.yaml",
      method: "tustin",
      sampleRateHz: 1000,
      kind: "stimulus",
      stimulus: { kind: "sine", freqHz: 3 },
      durationS: 1,
    });
    expect(sine.maxAbsError).toBeLessThan(0.02);
  });

  it("saves the discretized Block for use in Systems", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = await modelProject(h, c, { "blocks/lag.yaml": LAG });
    const r = await c.request("block.discretize", { block: "blocks/lag.yaml", method: "zoh", sampleRateHz: 100, save: "blocks/lag-100.yaml" });
    expect(r.saved).toBe("blocks/lag-100.yaml");
    const text = await readFile(join(path, "blocks/lag-100.yaml"), "utf8");
    expect(text).toMatch(/^# Discretized from blocks\/lag.yaml \(zoh, 100 Hz\) with tau=0.1/);
    expect((await c.request("blocks.list", {})).find((b) => b.path === "blocks/lag-100.yaml")).toMatchObject({
      kind: "transfer-function",
      domain: "discrete",
      linear: true,
    });
    await mkdir(join(path, "systems"), { recursive: true });
    await writeFile(
      join(path, "systems/d.yaml"),
      "sampleRateHz: 100\nblocks:\n  g: { block: blocks/lag-100.yaml }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n",
    );
    const step = await c.request("analysis.time", { system: "systems/d.yaml", kind: "step", durationS: 0.5 });
    step.series.y!.forEach((v, k) => expect(v).toBeCloseTo(1 - Math.exp(-k * 0.1), 12));
    // the wrong rate is caught by validation
    await writeFile(join(path, "systems/d.yaml"), (await readFile(join(path, "systems/d.yaml"), "utf8")).replace("sampleRateHz: 100", "sampleRateHz: 1000"));
    expect((await c.request("system.validate", { system: "systems/d.yaml" })).issues[0]?.code).toBe("sample_rate_mismatch");
  });

  it("refuses Blocks that are not continuous and linear", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/f.yaml": "kind: formula\noutputs:\n  y: u^2\n",
      "blocks/d.yaml": "kind: transfer-function\ndomain: discrete\nsampleRateHz: 100\nnumerator: [1]\ndenominator: [1, -0.5]\n",
    });
    for (const block of ["blocks/f.yaml", "blocks/d.yaml"]) {
      await expect(c.request("block.discretize", { block, method: "zoh", sampleRateHz: 100 })).rejects.toThrow(/not a continuous linear Block/);
    }
  });
});
