import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { Complex } from "@modelviz/protocol";
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

const tf = (num: (string | number)[], den: (string | number)[], params = "", domain = "continuous", rate = "") =>
  `kind: transfer-function\ndomain: ${domain}\n${rate}${params ? `parameters:\n${params}` : ""}numerator: ${JSON.stringify(num)}\ndenominator: ${JSON.stringify(den)}\n`;
const single = (block: string, fs = 1000) =>
  `sampleRateHz: ${fs}\ninputs: [r]\nblocks:\n  g: { block: ${block} }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n`;

const sortC = (zs: Complex[]) => [...zs].sort((a, b) => a.re - b.re || a.im - b.im);
const expectRoots = (got: Complex[], want: Complex[], tol = 1e-9) => {
  expect(got).toHaveLength(want.length);
  sortC(got).forEach((g, i) => {
    const w = sortC(want)[i]!;
    expect(Math.abs(g.re - w.re)).toBeLessThan(tol);
    expect(Math.abs(g.im - w.im)).toBeLessThan(tol);
  });
};

describe("analytic Frequency Response", () => {
  it("matches |H| and ∠H of a first-order lag and is labelled analytic", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/lag.yaml": tf([1], [0.01, 1]), "systems/lag.yaml": single("blocks/lag.yaml") });
    const r = await c.request("analysis.frequency", { system: "systems/lag.yaml", fMinHz: 0.1, fMaxHz: 400, points: 200 });
    expect(r).toMatchObject({ method: "analytic", domain: "continuous", input: "r" });
    r.frequencies.forEach((f, i) => {
      const wt = 2 * Math.PI * f * 0.01;
      expect(r.responses.y!.magnitudeDb[i]).toBeCloseTo(-10 * Math.log10(1 + wt * wt), 9);
      expect(r.responses.y!.phaseDeg[i]).toBeCloseTo((-Math.atan(wt) * 180) / Math.PI, 9);
    });
    // −3 dB bandwidth of 1/(τs+1) is 1/(2πτ)
    expect(r.metrics.y!.bandwidthHz).toBeCloseTo(1 / (2 * Math.PI * 0.01), 6);
    expect(r.metrics.y!.dcGainDb).toBeCloseTo(0, 12);
  });

  it("shows the resonance of an underdamped second-order Plant and unwraps phase", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/so.yaml": tf(["wn^2"], [1, "2*zeta*wn", "wn^2"], "  wn: { default: 100 }\n  zeta: { default: 0.1 }\n"),
      "blocks/cascade.yaml": tf([1], [1, 3, 3, 1]),
      "systems/so.yaml": single("blocks/so.yaml"),
      "systems/cascade.yaml": single("blocks/cascade.yaml"),
    });
    const r = await c.request("analysis.frequency", { system: "systems/so.yaml", points: 2000, fMinHz: 1, fMaxHz: 100 });
    const z = 0.1;
    // resonant peak 1/(2ζ√(1−ζ²)) at ωr = ωn√(1−2ζ²)
    expect(r.metrics.y!.peakGainDb).toBeCloseTo(20 * Math.log10(1 / (2 * z * Math.sqrt(1 - z * z))), 2);
    expect(r.metrics.y!.peakHz).toBeCloseTo((100 * Math.sqrt(1 - 2 * z * z)) / (2 * Math.PI), 1);
    // 1/(s+1)^3: phase runs continuously down to −270°
    const k = await c.request("analysis.frequency", { system: "systems/cascade.yaml", fMinHz: 0.001, fMaxHz: 400 });
    expect(k.responses.y!.phaseDeg.at(-1)!).toBeLessThan(-265);
  });

  it("uses H(e^{jωT}) for discrete Systems", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/d.yaml": tf([0.1, 0], [1, -0.9], "", "discrete", "sampleRateHz: 100\n"),
      "systems/d.yaml": single("blocks/d.yaml", 100),
    });
    const r = await c.request("analysis.frequency", { system: "systems/d.yaml", points: 50 });
    expect(r.domain).toBe("discrete");
    expect(r.frequencies.at(-1)!).toBeLessThan(50);
    r.frequencies.forEach((f, i) => {
      const w = (2 * Math.PI * f) / 100;
      // 0.1 z / (z − 0.9)
      const mag = 0.1 / Math.hypot(Math.cos(w) - 0.9, Math.sin(w));
      expect(r.responses.y!.magnitudeDb[i]).toBeCloseTo(20 * Math.log10(mag), 9);
    });
  });

  it("computes gain and phase margins of a loop broken at a Port", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/k.yaml": "kind: formula\nparameters: { K: { default: 1 } }\noutputs:\n  y: K*u\nlinear: true\n",
      "blocks/plant.yaml": tf([1], [1, 3, 2, 0]),
    });
    await c.request("system.fromLoopTemplate", { name: "loop", sampleRateHz: 1000, controller: "blocks/k.yaml", plant: "blocks/plant.yaml" });
    // L(s) = 1 / (s (s+1) (s+2)): phase crossover at ω = √2 with |L| = 1/6
    const r = await c.request("analysis.frequency", { system: "systems/loop.yaml", openLoopAt: "plant.u", fMinHz: 0.001, fMaxHz: 100, points: 400 });
    expect(r.loop!.at).toBe("plant.u");
    expect(r.loop!.phaseCrossoverHz! * 2 * Math.PI).toBeCloseTo(Math.SQRT2, 6);
    expect(r.loop!.gainMarginDb!).toBeCloseTo(20 * Math.log10(6), 6);
    // |L(jωc)| = 1 ⇒ ωc² (ωc² + 1)(ωc² + 4) = 1
    const wc = r.loop!.gainCrossoverHz! * 2 * Math.PI;
    expect(wc * wc * (wc * wc + 1) * (wc * wc + 4)).toBeCloseTo(1, 6);
    const pm = 180 - 90 - (Math.atan(wc) * 180) / Math.PI - (Math.atan(wc / 2) * 180) / Math.PI;
    expect(r.loop!.phaseMarginDeg!).toBeCloseTo(pm, 6);
    // closed-loop responses are of the intact System: y/r = L/(1+L), with |y/r(0)| = 1
    expect(r.metrics.y!.dcGainDb).toBeCloseTo(0, 9);
    const i = r.frequencies.findIndex((f) => f >= r.loop!.gainCrossoverHz!);
    expect(r.responses.y!.magnitudeDb[i]).toBeGreaterThan(-6);
    // a higher gain reduces the gain margin by exactly 20·log10(K)
    const k3 = await c.request("analysis.frequency", {
      system: "systems/loop.yaml",
      openLoopAt: "plant.u",
      fMinHz: 0.001,
      fMaxHz: 100,
      parameters: { controller: { K: 3 } },
    });
    expect(k3.loop!.gainMarginDb!).toBeCloseTo(20 * Math.log10(2), 6);
  });

  it("refuses nonlinear Systems", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/sq.yaml": "kind: formula\noutputs:\n  y: u^2\n", "systems/sq.yaml": single("blocks/sq.yaml") });
    await expect(c.request("analysis.frequency", { system: "systems/sq.yaml" })).rejects.toThrow(/needs a linear System: g .* not declared linear/);
  });
});

describe("pole-zero map", () => {
  it("finds the poles and zeros of a rational transfer function", async () => {
    await using h = await harness();
    const c = await h.client();
    // (s + 2) / ((s + 1)(s + 3))
    await modelProject(h, c, { "blocks/g.yaml": tf([1, 2], [1, 4, 3]), "systems/g.yaml": single("blocks/g.yaml") });
    const r = await c.request("analysis.poleZero", { system: "systems/g.yaml" });
    expectRoots(r.poles, [{ re: -1, im: 0 }, { re: -3, im: 0 }]);
    expectRoots(r.zeros.y!, [{ re: -2, im: 0 }]);
    expect(r).toMatchObject({ domain: "continuous", stable: true });
  });

  it("finds complex poles, closed-loop poles and stability", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/so.yaml": tf(["wn^2"], [1, "2*zeta*wn", "wn^2"], "  wn: { default: 10 }\n  zeta: { default: 0.3 }\n"),
      "systems/so.yaml": single("blocks/so.yaml"),
      "blocks/k.yaml": "kind: formula\nparameters: { K: { default: 4 } }\noutputs:\n  y: K*u\nlinear: true\n",
      "blocks/p.yaml": tf([1], [1, 1]),
      "blocks/unstable.yaml": tf([1], [1, -2]),
      "systems/unstable.yaml": single("blocks/unstable.yaml"),
    });
    const so = await c.request("analysis.poleZero", { system: "systems/so.yaml" });
    const wd = 10 * Math.sqrt(1 - 0.09);
    expectRoots(so.poles, [{ re: -3, im: wd }, { re: -3, im: -wd }]);
    expect(so.zeros.y).toEqual([]);

    await c.request("system.fromLoopTemplate", { name: "loop", sampleRateHz: 1000, controller: "blocks/k.yaml", plant: "blocks/p.yaml" });
    const loop = await c.request("analysis.poleZero", { system: "systems/loop.yaml" });
    // K/(s + 1 + K)
    expectRoots(loop.poles, [{ re: -5, im: 0 }]);
    expect((await c.request("analysis.poleZero", { system: "systems/unstable.yaml" })).stable).toBe(false);
  });

  it("reports z-plane poles for discrete Systems, including linear difference equations", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/de.yaml": "kind: difference-equation\nsampleRateHz: 100\nequations:\n  y: '1.5*y[n-1] - 0.7*y[n-2] + u[n-1]'\nlinear: true\n",
      "systems/de.yaml": single("blocks/de.yaml", 100),
    });
    const r = await c.request("analysis.poleZero", { system: "systems/de.yaml" });
    // z² − 1.5 z + 0.7
    const im = Math.sqrt(0.7 - 0.75 * 0.75);
    expectRoots(r.poles, [{ re: 0.75, im }, { re: 0.75, im: -im }]);
    expect(r).toMatchObject({ domain: "discrete", stable: true });
  });
});

describe("step Metrics", () => {
  it("matches overshoot, peak time and rise/settling times of a second-order Plant", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/so.yaml": tf(["wn^2"], [1, "2*zeta*wn", "wn^2"], "  wn: { default: 20 }\n  zeta: { default: 0.3 }\n"),
      "systems/so.yaml": single("blocks/so.yaml", 10000),
    });
    const r = await c.request("analysis.time", { system: "systems/so.yaml", kind: "step", durationS: 3 });
    const m = r.metrics!.y!;
    const z = 0.3;
    const wn = 20;
    const wd = wn * Math.sqrt(1 - z * z);
    expect(m.finalValue).toBeCloseTo(1, 6);
    expect(m.overshootPercent).toBeCloseTo(100 * Math.exp((-z * Math.PI) / Math.sqrt(1 - z * z)), 2);
    expect(m.peakTimeS).toBeCloseTo(Math.PI / wd, 3);
    // independent evaluation of the closed form for rise (10–90 %) and 2 % settling
    const y = (t: number) => 1 - (Math.exp(-z * wn * t) / Math.sqrt(1 - z * z)) * Math.sin(wd * t + Math.acos(z));
    const first = (lvl: number) => {
      let t = 0;
      while (y(t) < lvl) t += 1e-6;
      return t;
    };
    expect(m.riseTimeS!).toBeCloseTo(first(0.9) - first(0.1), 3);
    let ts = 3;
    while (Math.abs(y(ts) - 1) <= 0.02) ts -= 1e-5;
    expect(m.settlingTimeS!).toBeCloseTo(ts, 3);
  });
});
