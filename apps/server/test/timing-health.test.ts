import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { LinkHealth } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { benchProject, collectSamples, editYaml, harness } from "./harness.ts";

type H = Awaited<ReturnType<typeof harness>>;

/** Bench Project with edits applied to its manifest and Frame Format before (re)opening. */
async function customBench(h: H, c: ModelVizClient, edit: { manifest?: (d: any) => void; format?: (d: any) => void }) {
  const bench = await benchProject(h, c);
  if (edit.manifest) await editYaml(join(bench.path, "project.yaml"), edit.manifest);
  if (edit.format) await editYaml(join(bench.path, "frame-formats/bench.yaml"), edit.format);
  await c.request("project.open", { path: bench.path });
  const signals = await c.request("signals.list", {});
  return { ...bench, signals, byId: (id: string) => signals.find((s) => s.id === id)! };
}

function waitForHealth(c: ModelVizClient, pred: (h: LinkHealth) => boolean, timeoutMs = 5000): Promise<LinkHealth> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for link.health"));
    }, timeoutMs);
    const off = c.on("link.health", (h) => {
      if (pred(h)) {
        clearTimeout(timer);
        off();
        resolve(h);
      }
    });
  });
}

describe("batched samples", () => {
  it("expands each batched frame into consecutive samples at the right times", async () => {
    await using h = await harness();
    const c = await h.client();
    const { signals, byId } = await benchProject(h, c);
    expect(signals.some((s) => s.id.startsWith("bench/BENCH_IMU_BATCH.gyro_x["))).toBe(false);
    const gx = byId("bench/BENCH_IMU_BATCH.gyro_x");
    expect(gx.timebase).toBe("device");
    await c.request("signals.subscribe", { ids: [gx.id] });
    await c.request("source.startVirtual", { device: "bench" });
    const s = (await collectSamples(c, [gx.handle], (m) => m.get(gx.handle)!.values.length >= 400)).get(gx.handle)!;

    // 8 samples per frame at 1 kHz: every interval is exactly 1 ms, across frame boundaries too
    for (let i = 1; i < s.times.length; i++) expect(s.times[i]! - s.times[i - 1]!).toBeCloseTo(1, 6);
    // values follow the Virtual Device's 7 Hz sine at Device time (first sample is Device time 0)
    s.values.forEach((v, i) => {
      const t = (s.times[i]! - s.times[0]!) / 1000;
      expect(v).toBeCloseTo(Math.sin(2 * Math.PI * 7 * t), 5);
    });
  });

  it("supports a batch interval carried in a Field", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    const { readFile, writeFile } = await import("node:fs/promises");
    const dialect = join(path, "dialects/bench.xml");
    await writeFile(
      dialect,
      (await readFile(dialect, "utf8")).replace(
        '<field type="float[8]" name="gyro_x"',
        '<field type="uint16_t" name="dt_us" units="us">Sample interval.</field>\n      <field type="float[8]" name="gyro_x"',
      ),
    );
    await editYaml(join(path, "frame-formats/bench.yaml"), (d) => {
      d.messages.BENCH_IMU_BATCH.batch = { fields: ["gyro_x", "gyro_y", "gyro_z"], intervalField: { field: "dt_us", unit: "us" } };
    });
    await c.request("project.open", { path });
    const gx = (await c.request("signals.list", {})).find((s) => s.id === "bench/BENCH_IMU_BATCH.gyro_x")!;
    await c.request("signals.subscribe", { ids: [gx.id] });
    await c.request("source.startVirtual", { device: "bench" });
    const s = (await collectSamples(c, [gx.handle], (m) => m.get(gx.handle)!.values.length >= 100)).get(gx.handle)!;
    for (let i = 1; i < s.times.length; i++) expect(s.times[i]! - s.times[i - 1]!).toBeCloseTo(1, 6);
  });

  it("reports an invalid batch declaration as a Device error", async () => {
    await using h = await harness();
    const c = await h.client();
    await customBench(h, c, {
      format: (d) => {
        d.messages.BENCH_STATE.batch = { fields: ["setpoint"], sampleRateHz: 1000 };
      },
    });
    const [device] = await c.request("devices.list", {});
    expect(device?.error).toMatch(/batch Fields must be numeric arrays/);
  });
});

describe("Device Timestamps", () => {
  it("uses Device Timestamps despite host jitter and keeps Host Timestamps alongside", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await customBench(h, c, {
      manifest: (d) => {
        d.devices[0].virtual.faults = { jitterMs: 25 };
      },
    });
    const sp = byId("bench/BENCH_STATE.setpoint");
    expect(sp.timebase).toBe("device");
    await c.request("signals.subscribe", { ids: [sp.id] });
    await c.request("source.startVirtual", { device: "bench" });
    const s = (await collectSamples(c, [sp.handle], (m) => m.get(sp.handle)!.values.length >= 300)).get(sp.handle)!;
    // Device clock: exactly the 500 Hz period
    for (let i = 1; i < s.times.length; i++) expect(s.times[i]! - s.times[i - 1]!).toBeCloseTo(2, 6);
    // Host clock: same number of samples, but irregular arrival
    expect(s.hostTimes).toHaveLength(s.times.length);
    const hostSteps = new Set(s.hostTimes.slice(1).map((t, i) => t - s.hostTimes[i]!));
    expect(hostSteps.size).toBeGreaterThan(2);
    // Device time is anchored near the host clock
    expect(Math.abs(s.times[0]! - s.hostTimes[0]!)).toBeLessThan(1000);
  });

  it("falls back to Host Timestamps when no Device Timestamp is declared", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await benchProject(h, c);
    const hb = byId("bench/HEARTBEAT.type");
    expect(hb.timebase).toBe("host");
    await c.request("signals.subscribe", { ids: [hb.id] });
    await c.request("source.startVirtual", { device: "bench" });
    const s = (await collectSamples(c, [hb.handle], (m) => m.get(hb.handle)!.values.length >= 1)).get(hb.handle)!;
    expect(s.hostTimes).toHaveLength(0);
    expect(Math.abs(s.times[0]! - Date.now())).toBeLessThan(2000);
  });
});

describe("link health", () => {
  it("reports a healthy link with measured rates against the Nominal Rate", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    await c.request("source.startVirtual", { device: "bench" });
    const health = await waitForHealth(c, (x) => (x.messages.BENCH_STATE?.rateHz ?? 0) > 0);
    expect(health).toMatchObject({ device: "bench", crcErrors: 0, sequenceGaps: 0 });
    const state = health.messages.BENCH_STATE!;
    expect(state.nominalRateHz).toBe(500);
    expect(state.rateHz).toBeGreaterThan(400);
    expect(state.rateHz).toBeLessThan(600);
    expect(state).toMatchObject({ missedFrames: 0, timingJumps: 0, rateDeviation: false });
    expect(await c.request("link.health", { device: "bench" })).toMatchObject({ device: "bench" });
  });

  it("counts dropped frames from sequence gaps and Device Timestamp gaps", async () => {
    await using h = await harness();
    const c = await h.client();
    await customBench(h, c, {
      manifest: (d) => {
        d.devices[0].virtual.faults = { dropEvery: 10 };
      },
    });
    await c.request("source.startVirtual", { device: "bench" });
    const health = await waitForHealth(c, (x) => (x.messages.BENCH_STATE?.missedFrames ?? 0) > 5);
    expect(health.sequenceGaps).toBeGreaterThan(5);
    expect(health.crcErrors).toBe(0);
    expect(health.messages.BENCH_STATE!.timingJumps).toBe(0);
  });

  it("counts CRC failures", async () => {
    await using h = await harness();
    const c = await h.client();
    await customBench(h, c, {
      manifest: (d) => {
        d.devices[0].virtual.faults = { corruptEvery: 7 };
      },
    });
    await c.request("source.startVirtual", { device: "bench" });
    const health = await waitForHealth(c, (x) => x.crcErrors > 5);
    // a corrupted frame is rejected, so it also shows up as a sequence gap
    expect(health.sequenceGaps).toBeGreaterThan(0);
  });

  it("flags timing jumps when the Device clock runs backwards", async () => {
    await using h = await harness();
    const c = await h.client();
    await customBench(h, c, {
      manifest: (d) => {
        d.devices[0].virtual.messages.BENCH_STATE.fields.time_us = { kind: "ramp", start: 1e9, step: -2000 };
      },
    });
    await c.request("source.startVirtual", { device: "bench" });
    const health = await waitForHealth(c, (x) => (x.messages.BENCH_STATE?.timingJumps ?? 0) > 10);
    expect(health.messages.BENCH_STATE!.missedFrames).toBe(0);
  });

  it("flags a rate that deviates from the Nominal Rate", async () => {
    await using h = await harness();
    const c = await h.client();
    await customBench(h, c, {
      format: (d) => {
        d.messages.BENCH_STATE.nominalRateHz = 1000;
      },
    });
    await c.request("source.startVirtual", { device: "bench" });
    const health = await waitForHealth(c, (x) => x.messages.BENCH_STATE?.rateDeviation === true);
    expect(health.messages.BENCH_STATE!.nominalRateHz).toBe(1000);
  });
});
