import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { SourceState } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { benchProject, collectSamples, editYaml, harness } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitForSource(c: ModelVizClient, pred: (s: SourceState) => boolean, timeoutMs = 8000): Promise<SourceState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for source state"));
    }, timeoutMs);
    const off = c.on("source.changed", (s) => {
      if (pred(s)) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });
}

/** Records the bench Virtual Device for about `ms`. */
async function recordBench(c: ModelVizClient, ms: number, name = "run1") {
  await c.request("source.startVirtual", { device: "bench" });
  await waitForSource(c, (s) => s.state === "running");
  await c.request("recording.start", { device: "bench", name });
  await sleep(ms);
  const info = await c.request("recording.stop", { device: "bench" });
  await c.request("source.stop", { device: "bench" });
  return info;
}

describe("Recording", () => {
  it("stores the raw byte stream in the Project's recordings folder", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    const changes: boolean[] = [];
    c.on("recording.changed", (r) => changes.push(r.active));
    const info = await recordBench(c, 600);
    expect(info).toMatchObject({ id: "run1", device: "bench", active: false });
    expect(info.durationMs).toBeGreaterThan(400);
    expect(info.bytes).toBeGreaterThan(10_000);
    expect(changes[0]).toBe(true);
    expect(changes.at(-1)).toBe(false);

    const file = join(path, "recordings/run1.mvrec");
    expect((await stat(file)).size).toBeGreaterThan(info.bytes);
    expect((await readFile(join(path, ".gitignore"), "utf8"))).toContain("recordings/");
    expect(await readFile(join(path, "project.yaml"), "utf8")).not.toContain("run1");
    expect(await c.request("recordings.list", {})).toEqual([info]);
  });

  it("refuses to record without a running Source or twice at once", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    await expect(c.request("recording.start", { device: "bench" })).rejects.toMatchObject({ code: "conflict" });
    await c.request("source.startVirtual", { device: "bench" });
    await waitForSource(c, (s) => s.state === "running");
    await c.request("recording.start", { device: "bench", name: "a" });
    await expect(c.request("recording.start", { device: "bench" })).rejects.toMatchObject({ code: "conflict" });
    // stopping the Source finishes the Recording
    const done = new Promise((r) => c.on("recording.changed", (x) => !x.active && r(x)));
    await c.request("source.stop", { device: "bench" });
    await done;
    await expect(c.request("recording.start", { device: "bench", name: "a" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("captures the full ADR-0006 rate without loss", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = join(h.dir, "fast");
    await c.request("project.create", { path, name: "fast" });
    await mkdir(join(path, "dialects"));
    await copyFile(join(import.meta.dirname, "fixtures/throughput.xml"), join(path, "dialects/fast.xml"));
    await writeFile(join(path, "fast.yaml"), "framing: mavlink2\ndialect: dialects/fast.xml\nmessages:\n  FAST:\n    deviceTimestamp: { field: time_us, unit: us }\n    nominalRateHz: 8000\n");
    const fields = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`ch${i}`, { kind: "ramp", start: i, step: 1 }]));
    await writeFile(
      join(path, "project.yaml"),
      JSON.stringify({ schemaVersion: 1, name: "fast", devices: [{ id: "fast", frameFormat: "fast.yaml", virtual: { messages: { FAST: { rateHz: 8000, fields } } } }] }),
    );
    await c.request("project.open", { path });
    await c.request("source.startVirtual", { device: "fast" });
    await c.request("recording.start", { device: "fast", name: "burst" });
    await sleep(2000);
    await c.request("recording.stop", { device: "fast" });
    await c.request("source.stop", { device: "fast" });

    // replay fast and check every frame is there, in order
    const ch3 = (await c.request("signals.list", {})).find((s) => s.id === "fast/FAST.ch3")!;
    await c.request("signals.subscribe", { ids: [ch3.id] });
    const collecting = collectSamples(c, [ch3.handle], (m) => m.get(ch3.handle)!.values.length >= 14000, 15000);
    await c.request("source.startReplay", { device: "fast", recording: "burst", speed: 8 });
    const values = (await collecting).get(ch3.handle)!.values;
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1]! + 1) throw new Error(`gap at ${i}: ${values[i - 1]} → ${values[i]}`);
    }
  }, 30000);
});

describe("Log Replay", () => {
  it("reproduces the original timing and Host Timestamps", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await benchProject(h, c);
    const sp = byId("bench/HEARTBEAT.type");
    const gx = byId("bench/BENCH_STATE.setpoint");
    const info = await recordBench(c, 800);
    // subscribe only now, so no live sample from the recording run can arrive late
    await c.request("signals.subscribe", { ids: [gx.id, sp.id] });

    const replayed = collectSamples(c, [gx.handle], (m) => m.get(gx.handle)!.values.length >= 300, 5000);
    const ended = waitForSource(c, (s) => s.replay?.playing === false && s.replay.positionMs === s.replay.durationMs, 8000);
    const t0 = Date.now();
    const st = await c.request("source.startReplay", { device: "bench", recording: "run1" });
    expect(st).toMatchObject({ kind: "replay", replay: { recording: "run1", playing: true, speed: 1 } });
    const r = (await replayed).get(gx.handle)!;
    // Host Timestamps are the recorded ones, within the Recording's span
    for (const t of r.hostTimes) {
      expect(t).toBeGreaterThanOrEqual(info.startedAt);
      expect(t).toBeLessThanOrEqual(info.startedAt + info.durationMs);
    }
    // plays with the original timing: wall-clock time ≥ the span of the replayed Host Timestamps
    const span = r.hostTimes.at(-1)! - r.hostTimes[0]!;
    expect(span).toBeGreaterThan(100);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(span - 50);
    await ended;
  });

  it("pauses, seeks and changes speed", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await benchProject(h, c);
    const time = byId("bench/BENCH_STATE.time_us");
    const info = await recordBench(c, 1500);
    await c.request("signals.subscribe", { ids: [time.id] });
    await c.request("source.startReplay", { device: "bench", recording: "run1" });

    const paused = await c.request("replay.control", { device: "bench", action: "pause" });
    expect(paused.replay?.playing).toBe(false);
    await sleep(150);
    let after = 0;
    const off = c.onSignalChunk(() => after++);
    await sleep(200);
    off();
    expect(after).toBe(0);

    const reset = new Promise((r) => c.on("signals.reset", r));
    const mid = info.durationMs / 2;
    const seeked = await c.request("replay.control", { device: "bench", action: "seek", positionMs: mid });
    expect(seeked.replay?.positionMs).toBeCloseTo(mid, 0);
    expect(await reset).toEqual({ device: "bench" });

    const sped = await c.request("replay.control", { device: "bench", action: "speed", speed: 4 });
    expect(sped.replay?.speed).toBe(4);
    const collecting = collectSamples(c, [time.handle], (m) => m.get(time.handle)!.values.length >= 50);
    await c.request("replay.control", { device: "bench", action: "play" });
    const vals = (await collecting).get(time.handle)!.values;
    // Device time resumes from around the middle of the Recording, not from the start
    expect(vals[0]! / 1000).toBeGreaterThan(mid * 0.5);
  });

  it("re-decodes a Recording with an updated Frame Format", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    // capture with a Frame Format that does not know BENCH_IMU_BATCH is batched
    await editYaml(join(path, "frame-formats/bench.yaml"), (d) => {
      delete d.messages.BENCH_IMU_BATCH.batch;
    });
    await c.request("project.open", { path });
    let signals = await c.request("signals.list", {});
    expect(signals.some((s) => s.id === "bench/BENCH_IMU_BATCH.gyro_x[0]")).toBe(true);
    await recordBench(c, 500);

    // fix the Frame Format and replay the same bytes
    await editYaml(join(path, "frame-formats/bench.yaml"), (d) => {
      d.messages.BENCH_IMU_BATCH.batch = { fields: ["gyro_x", "gyro_y", "gyro_z"], sampleRateHz: 1000 };
    });
    await c.request("project.open", { path });
    signals = await c.request("signals.list", {});
    const gx = signals.find((s) => s.id === "bench/BENCH_IMU_BATCH.gyro_x")!;
    expect(gx).toBeDefined();
    await c.request("signals.subscribe", { ids: [gx.id] });
    const collecting = collectSamples(c, [gx.handle], (m) => m.get(gx.handle)!.values.length >= 200);
    await c.request("source.startReplay", { device: "bench", recording: "run1", speed: 4 });
    const s = (await collecting).get(gx.handle)!;
    for (let i = 1; i < s.times.length; i++) expect(s.times[i]! - s.times[i - 1]!).toBeCloseTo(1, 6);
  });

  it("refuses a Recording made with a different dialect", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    await recordBench(c, 300);
    const xml = join(path, "dialects/bench.xml");
    await writeFile(xml, (await readFile(xml, "utf8")).replace('name="mode"', 'name="mode2"'));
    await c.request("project.open", { path });
    await expect(c.request("source.startReplay", { device: "bench", recording: "run1" })).rejects.toThrow(/Dialect hash mismatch/);
  });

  it("rejects unknown Recordings and Recordings of another Device", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    await expect(c.request("source.startReplay", { device: "bench", recording: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(c.request("replay.control", { device: "bench", action: "pause" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("Log Replay robustness", () => {
  it("rejects the replay instead of crashing when its Recording disappears", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    await recordBench(c, 1500);
    const rejected = waitForSource(c, (s) => s.state === "rejected", 8000);
    await c.request("source.startReplay", { device: "bench", recording: "run1", speed: 0.25 });
    const { rm } = await import("node:fs/promises");
    await rm(join(path, "recordings"), { recursive: true, force: true });
    expect((await rejected).error).toMatch(/Log Replay failed: .*ENOENT/);
    // the server is still alive
    expect(await c.request("project.current", {})).toMatchObject({ path });
  });
});
