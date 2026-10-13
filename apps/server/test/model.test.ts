import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import { describe, expect, it } from "vitest";
import { collectSamples, harness } from "./harness.ts";

type H = Awaited<ReturnType<typeof harness>>;

/** Empty Project with the given files (path → YAML text). */
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

const FIRST_ORDER = `kind: transfer-function
domain: continuous
parameters:
  tau: { default: 0.1, units: s }
numerator: [1]
denominator: [tau, 1]
`;
const SECOND_ORDER = `kind: transfer-function
domain: continuous
parameters:
  wn: { default: 20 }
  zeta: { default: 0.3 }
numerator: ["wn^2"]
denominator: [1, "2*zeta*wn", "wn^2"]
`;
const single = (block: string, fs = 1000) => `sampleRateHz: ${fs}
inputs: [r]
blocks:
  g: { block: ${block} }
connections:
  - { from: r, to: g.u }
outputs: { y: g.y }
`;

const maxErr = (a: number[], b: (i: number) => number, from = 0) => Math.max(...a.slice(from).map((v, i) => Math.abs(v - b(i + from))));

describe("declarative Blocks and time-domain Analyses", () => {
  it("matches the closed-form step and impulse response of a first-order Plant", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/lag.yaml": FIRST_ORDER, "systems/lag.yaml": single("blocks/lag.yaml") });
    const step = await c.request("analysis.time", { system: "systems/lag.yaml", kind: "step", durationS: 1 });
    expect(step.times).toHaveLength(1001);
    expect(maxErr(step.series.y!, (i) => 1 - Math.exp(-step.times[i]! / 0.1))).toBeLessThan(1e-6);
    expect(step.series.r![0]).toBe(1);

    const imp = await c.request("analysis.time", { system: "systems/lag.yaml", kind: "impulse", durationS: 1 });
    // a one-sample pulse of area 1 approximates a Dirac impulse: y ≈ e^{-t/τ}/τ after the pulse
    const ideal = (i: number) => Math.exp(-imp.times[i]! / 0.1) / 0.1;
    expect(maxErr(imp.series.y!, ideal, 2) / 10).toBeLessThan(0.01);
  });

  it("matches the closed-form step response of an underdamped second-order Plant", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/so.yaml": SECOND_ORDER, "systems/so.yaml": single("blocks/so.yaml") });
    const r = await c.request("analysis.time", { system: "systems/so.yaml", kind: "step", durationS: 1 });
    const wn = 20;
    const z = 0.3;
    const wd = wn * Math.sqrt(1 - z * z);
    const phi = Math.acos(z);
    const ideal = (i: number) => {
      const t = r.times[i]!;
      return 1 - (Math.exp(-z * wn * t) / Math.sqrt(1 - z * z)) * Math.sin(wd * t + phi);
    };
    expect(maxErr(r.series.y!, ideal)).toBeLessThan(1e-6);
    // Block Parameter overrides apply per Analysis
    const fast = await c.request("analysis.time", {
      system: "systems/so.yaml",
      kind: "step",
      durationS: 1,
      parameters: { g: { zeta: 1 } },
    });
    expect(Math.max(...fast.series.y!)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("supports state-space, discrete transfer functions, difference equations and formulas", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/ss.yaml": `kind: state-space
domain: continuous
parameters: { a: { default: 5 } }
A: [["-a"]]
B: [[1]]
C: [["a"]]
D: [[0]]
`,
      "blocks/dtf.yaml": `kind: transfer-function
domain: discrete
sampleRateHz: 100
parameters: { a: { default: 0.9 } }
numerator: ["1-a", 0]
denominator: [1, "-a"]
`,
      "blocks/de.yaml": `kind: difference-equation
sampleRateHz: 100
parameters: { a: { default: 0.9 } }
equations:
  y: "a*y[n-1] + (1-a)*u[n]"
linear: true
`,
      "blocks/sq.yaml": `kind: formula
parameters: { k: { default: 2 } }
outputs:
  y: "k*u^2 + t"
`,
      "systems/ss.yaml": single("blocks/ss.yaml"),
      "systems/dtf.yaml": single("blocks/dtf.yaml", 100),
      "systems/de.yaml": single("blocks/de.yaml", 100),
      "systems/sq.yaml": single("blocks/sq.yaml", 10),
    });
    const ss = await c.request("analysis.time", { system: "systems/ss.yaml", kind: "step", durationS: 1 });
    expect(maxErr(ss.series.y!, (i) => 1 - Math.exp(-5 * ss.times[i]!))).toBeLessThan(1e-6);
    // discrete first-order lag: y[k] = 1 − a^{k+1}
    for (const sys of ["systems/dtf.yaml", "systems/de.yaml"]) {
      const d = await c.request("analysis.time", { system: sys, kind: "step", durationS: 0.5 });
      expect(maxErr(d.series.y!, (k) => 1 - 0.9 ** (k + 1))).toBeLessThan(1e-12);
    }
    const sq = await c.request("analysis.time", { system: "systems/sq.yaml", kind: "step", durationS: 1 });
    expect(sq.series.y!).toEqual(sq.times.map((t) => 2 + t));
    expect(await c.request("blocks.list", {})).toContainEqual(
      expect.objectContaining({ path: "blocks/de.yaml", kind: "difference-equation", domain: "discrete", linear: true, inputs: ["u"], outputs: ["y"] }),
    );
  });

  it("drives Systems with chirp, sine and sine-sweep Stimuli", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/pass.yaml": "kind: formula\noutputs:\n  y: u\nlinear: true\n",
      "systems/pass.yaml": single("blocks/pass.yaml"),
    });
    const sine = await c.request("analysis.time", {
      system: "systems/pass.yaml",
      kind: "stimulus",
      stimulus: { kind: "sine", freqHz: 5, amplitude: 2 },
      durationS: 1,
    });
    expect(maxErr(sine.series.y!, (i) => 2 * Math.sin(2 * Math.PI * 5 * sine.times[i]!))).toBeLessThan(1e-12);
    for (const kind of ["chirp", "sineSweep"] as const) {
      const r = await c.request("analysis.time", {
        system: "systems/pass.yaml",
        kind: "stimulus",
        stimulus: { kind, f0Hz: 1, f1Hz: 50 },
        durationS: 2,
      });
      // instantaneous frequency rises: zero crossings get denser towards the end
      const crossings = (from: number, to: number) =>
        r.series.y!.slice(from, to).filter((v, i, a) => i > 0 && Math.sign(v) !== Math.sign(a[i - 1]!)).length;
      expect(crossings(1500, 2000)).toBeGreaterThan(crossings(0, 500) * 3);
    }
  });
});

describe("Systems and the Loop Template", () => {
  const P = `kind: formula
parameters: { K: { default: 4 } }
outputs:
  y: K*u
linear: true
`;

  it("creates an ordinary System graph from the Loop Template that matches the closed-loop response", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = await modelProject(h, c, { "blocks/p.yaml": P, "blocks/plant.yaml": FIRST_ORDER.replace("0.1", "1") });
    const info = await c.request("system.fromLoopTemplate", {
      name: "loop",
      sampleRateHz: 1000,
      controller: "blocks/p.yaml",
      plant: "blocks/plant.yaml",
    });
    expect(info).toMatchObject({ path: "systems/loop.yaml", name: "loop", inputs: ["r"], outputs: ["y", "u", "e"], issues: [] });
    expect(info.ports).toEqual(["error.in1", "error.in2", "controller.u", "plant.u"]);
    const text = await readFile(join(path, "systems/loop.yaml"), "utf8");
    expect(text).toContain("kind: sum");
    expect(text).toContain("from: error.out");

    const r = await c.request("analysis.time", { system: "systems/loop.yaml", kind: "step", durationS: 2 });
    // The controller acts on samples, so this is a sampled-data loop: with the Plant held
    // between samples, y[k+1] = a·y[k] + (1−a)·K·(1 − y[k]), a = e^{−dt}, exactly.
    const K = 4;
    const a = Math.exp(-1 / 1000);
    const p = a - (1 - a) * K;
    const yss = K / (1 + K);
    expect(maxErr(r.series.y!, (k) => yss * (1 - p ** k))).toBeLessThan(1e-9);
    // …which converges to the continuous loop K/(s+1+K) as dt → 0
    expect(maxErr(r.series.y!, (i) => yss * (1 - Math.exp(-(1 + K) * r.times[i]!)))).toBeLessThan(1e-3);
    expect(r.series.e![0]).toBe(1);
    await expect(
      c.request("system.fromLoopTemplate", { name: "loop", sampleRateHz: 1000, controller: "blocks/p.yaml", plant: "blocks/plant.yaml" }),
    ).rejects.toMatchObject({ code: "already_exists" });
  });

  it("includes an optional sensor filter in the feedback path", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/p.yaml": P, "blocks/plant.yaml": FIRST_ORDER.replace("0.1", "1"), "blocks/lpf.yaml": FIRST_ORDER.replace("0.1", "0.01") });
    const info = await c.request("system.fromLoopTemplate", {
      name: "loop",
      sampleRateHz: 1000,
      controller: "blocks/p.yaml",
      plant: "blocks/plant.yaml",
      sensor: "blocks/lpf.yaml",
    });
    expect(info.outputs).toEqual(["y", "u", "e", "ym"]);
    const r = await c.request("analysis.time", { system: "systems/loop.yaml", kind: "step", durationS: 3 });
    expect(r.series.y!.at(-1)).toBeCloseTo(4 / 5, 3);
  });

  it("validates unconnected Ports, multiple drivers, sample rates and algebraic loops", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/p.yaml": P,
      "blocks/dtf.yaml": "kind: transfer-function\ndomain: discrete\nsampleRateHz: 100\nnumerator: [1]\ndenominator: [1, -0.5]\n",
      "systems/unconnected.yaml": "sampleRateHz: 1000\nblocks:\n  a: { block: blocks/p.yaml }\nconnections: []\noutputs: { y: a.y }\n",
      "systems/double.yaml": "sampleRateHz: 1000\ninputs: [r, s]\nblocks:\n  a: { block: blocks/p.yaml }\nconnections:\n  - { from: r, to: a.u }\n  - { from: s, to: a.u }\noutputs: { y: a.y }\n",
      "systems/rate.yaml": "sampleRateHz: 1000\nblocks:\n  d: { block: blocks/dtf.yaml }\nconnections:\n  - { from: r, to: d.u }\noutputs: { y: d.y }\n",
      "systems/loop.yaml": "sampleRateHz: 1000\nblocks:\n  s: { kind: sum, signs: '+-' }\n  a: { block: blocks/p.yaml }\nconnections:\n  - { from: r, to: s.in1 }\n  - { from: a.y, to: s.in2 }\n  - { from: s.out, to: a.u }\noutputs: { y: a.y }\n",
      "systems/ports.yaml": "sampleRateHz: 1000\nblocks:\n  a: { block: blocks/p.yaml }\nconnections:\n  - { from: r, to: a.nope }\n  - { from: b.y, to: a.u }\noutputs: { y: a.x }\n",
    });
    const codes = async (sys: string) => (await c.request("system.validate", { system: sys })).issues.map((i) => i.code);
    expect(await codes("systems/unconnected.yaml")).toEqual(["unconnected_port"]);
    expect(await codes("systems/double.yaml")).toEqual(["multiple_drivers"]);
    expect(await codes("systems/rate.yaml")).toEqual(["sample_rate_mismatch"]);
    expect(await codes("systems/loop.yaml")).toEqual(["algebraic_loop"]);
    expect(new Set(await codes("systems/ports.yaml"))).toEqual(new Set(["unknown_port", "unknown_block"]));
    const loop = (await c.request("system.validate", { system: "systems/loop.yaml" })).issues[0]!;
    expect(loop.message).toMatch(/s → a → s|a → s → a/);
    await expect(c.request("analysis.time", { system: "systems/loop.yaml", kind: "step", durationS: 1 })).rejects.toMatchObject({
      code: "invalid_system",
    });
    const systems = await c.request("systems.list", {});
    expect(systems.find((s) => s.path === "systems/rate.yaml")?.issues[0]?.message).toMatch(/designed for 100 Hz/);
  });

  it("reports invalid Block definitions clearly", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, {
      "blocks/improper.yaml": "kind: transfer-function\ndomain: continuous\nnumerator: [1, 0, 0]\ndenominator: [1, 1]\n",
      "blocks/badexpr.yaml": "kind: transfer-function\ndomain: continuous\nnumerator: ['2*']\ndenominator: [1, 1]\n",
      "blocks/unknown.yaml": "kind: transfer-function\ndomain: continuous\nnumerator: [k]\ndenominator: [1, 1]\n",
    });
    const blocks = await c.request("blocks.list", {});
    const err = (p: string) => blocks.find((b) => b.path === p)?.error;
    expect(err("blocks/improper.yaml")).toMatch(/improper/);
    expect(err("blocks/badexpr.yaml")).toMatch(/Unexpected end/);
    expect(err("blocks/unknown.yaml")).toMatch(/Unknown name "k"/);
  });

  it("publishes System outputs as Signals and edits model files through the protocol", async () => {
    await using h = await harness();
    const c = await h.client();
    await modelProject(h, c, { "blocks/lag.yaml": FIRST_ORDER, "systems/lag.yaml": single("blocks/lag.yaml") });
    const sig = (await c.request("signals.list", {})).find((s) => s.id === "system:lag/out.y")!;
    expect(sig).toBeDefined();
    await c.request("signals.subscribe", { ids: [sig.id] });
    const got = collectSamples(c, [sig.handle], (m) => m.get(sig.handle)!.values.length >= 1001);
    await c.request("analysis.time", { system: "systems/lag.yaml", kind: "step", durationS: 1 });
    const s = (await got).get(sig.handle)!;
    expect(s.values.at(-1)).toBeCloseTo(1 - Math.exp(-10), 6);
    expect(s.times[1]! - s.times[0]!).toBeCloseTo(1, 6);

    expect(await c.request("files.list", {})).toEqual(
      expect.arrayContaining([
        { path: "blocks/lag.yaml", kind: "block" },
        { path: "systems/lag.yaml", kind: "system" },
        { path: "project.yaml", kind: "other" },
      ]),
    );
    const { content } = await c.request("files.read", { path: "blocks/lag.yaml" });
    await c.request("files.write", { path: "blocks/lag.yaml", content: content.replace("0.1", "0.5") });
    const r = await c.request("analysis.time", { system: "systems/lag.yaml", kind: "step", durationS: 1 });
    expect(r.series.y!.at(-1)).toBeCloseTo(1 - Math.exp(-2), 6);
    await expect(c.request("files.write", { path: "../escape.yaml", content: "x" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(c.request("files.write", { path: "notes.txt", content: "x" })).rejects.toMatchObject({ code: "invalid_params" });
  });
});
