import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { SourceState } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { benchProject, collectSamples, harness } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitForSource(c: ModelVizClient, pred: (s: SourceState) => boolean, timeoutMs = 8000): Promise<SourceState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
    const off = c.on("source.changed", (s) => {
      if (pred(s)) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });
}

/** Bench Project plus a gain System running at the bench's 500 Hz rate. */
async function project(h: Awaited<ReturnType<typeof harness>>, c: ModelVizClient) {
  const bench = await benchProject(h, c);
  await mkdir(join(bench.path, "systems"), { recursive: true });
  await writeFile(join(bench.path, "blocks/double.yaml"), "kind: formula\noutputs:\n  y: 2*u\nlinear: true\n");
  await writeFile(
    join(bench.path, "systems/double.yaml"),
    "sampleRateHz: 500\ninputs: [r]\nblocks:\n  g: { block: blocks/double.yaml }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n",
  );
  await writeFile(
    join(bench.path, "systems/fast.yaml"),
    "sampleRateHz: 2000\ninputs: [r]\nblocks:\n  g: { block: blocks/double.yaml }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n",
  );
  await c.request("project.open", { path: bench.path });
  return bench;
}

describe("Systems driven by recorded Signals", () => {
  it("feeds a Recording's Signal into a System", async () => {
    await using h = await harness();
    const c = await h.client();
    await project(h, c);
    await c.request("source.startVirtual", { device: "bench" });
    await waitForSource(c, (s) => s.state === "running");
    await c.request("recording.start", { device: "bench", name: "run" });
    await sleep(600);
    await c.request("recording.stop", { device: "bench" });
    await c.request("source.stop", { device: "bench" });

    const r = await c.request("analysis.time", {
      system: "systems/double.yaml",
      kind: "signal",
      signal: { recording: "run", signal: "bench/BENCH_STATE.setpoint" },
      durationS: 10,
    });
    // limited to the Signal's length; same rate, so every System sample is a recorded sample
    expect(r.times.at(-1)!).toBeLessThan(0.7);
    expect(r.times.length).toBeGreaterThan(200);
    r.series.y!.forEach((y, i) => expect(y).toBe(2 * r.series.r![i]!));
    // the setpoint is the Virtual Device's 0.5 Hz sine: consecutive samples 2 ms apart follow it
    const w = 2 * Math.PI * 0.5;
    const phase = Math.atan2(r.series.r![0]!, (r.series.r![1]! - r.series.r![0]!) / (w * 0.002));
    r.series.r!.forEach((u, i) => expect(u).toBeCloseTo(Math.sin(w * r.times[i]! + phase), 3));
  });

  it("holds recorded samples between them when the System runs faster, and honours startS", async () => {
    await using h = await harness();
    const c = await h.client();
    await project(h, c);
    const csv = join(h.dir, "steps.csv");
    await writeFile(csv, "t,u\n0,0\n0.1,1\n0.2,3\n0.3,3\n");
    await c.request("csv.import", { path: csv, name: "steps" });
    const r = await c.request("analysis.time", {
      system: "systems/fast.yaml",
      kind: "signal",
      signal: { recording: "steps", signal: "steps/CSV.u" },
      durationS: 1,
    });
    expect(r.times.at(-1)!).toBeCloseTo(0.3, 9);
    const at = (t: number) => r.series.r![Math.round(t * 2000)]!;
    expect([at(0.05), at(0.1), at(0.15), at(0.25)]).toEqual([0, 1, 1, 3]);
    const late = await c.request("analysis.time", {
      system: "systems/fast.yaml",
      kind: "signal",
      signal: { recording: "steps", signal: "steps/CSV.u", startS: 0.15 },
      durationS: 1,
    });
    expect(late.series.r![0]).toBe(1);
    await expect(
      c.request("analysis.time", { system: "systems/fast.yaml", kind: "signal", signal: { recording: "steps", signal: "steps/CSV.nope" }, durationS: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("Systems driven by live Signals", () => {
  it("streams model output on the input Signal's time axis with at most one chunk of latency", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await project(h, c);
    const sp = byId("bench/BENCH_STATE.setpoint");
    const out = (await c.request("signals.list", {})).find((s) => s.id === "system:double/out.y")!;
    await c.request("signals.subscribe", { ids: [sp.id, out.id] });
    await c.request("source.startVirtual", { device: "bench" });
    const st = await c.request("system.live.start", { system: "systems/double.yaml", signal: sp.id });
    expect(st).toMatchObject({ running: true, input: "r", signal: sp.id });

    const arrivals: number[] = [];
    const lag: number[] = [];
    c.onSignalChunk((ch) => {
      if (ch.handle !== out.handle) return;
      arrivals.push(Date.now());
      lag.push(Date.now() - ch.times.at(-1)!);
    });
    const s = await collectSamples(c, [sp.handle, out.handle], (m) => m.get(out.handle)!.values.length >= 300);
    // every model sample lines up with a measured sample: y = 2·u at the same time
    const measured = new Map(s.get(sp.handle)!.times.map((t, i) => [t, s.get(sp.handle)!.values[i]!]));
    const model = s.get(out.handle)!;
    let matched = 0;
    model.times.forEach((t, i) => {
      const u = measured.get(t);
      if (u !== undefined) {
        expect(model.values[i]).toBeCloseTo(2 * u, 12);
        matched++;
      }
    });
    expect(matched).toBeGreaterThan(200);
    // latency: chunk interval + Signal flush + transport, well under a few chunks
    const sorted = [...lag].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(200);

    expect(await c.request("system.live.list", {})).toMatchObject([{ system: "systems/double.yaml", running: true }]);
    const stopped = await c.request("system.live.stop", { system: "systems/double.yaml" });
    expect(stopped.running).toBe(false);
    expect(stopped.samples).toBeGreaterThanOrEqual(300);
    await expect(c.request("system.live.start", { system: "systems/double.yaml", signal: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });
});
