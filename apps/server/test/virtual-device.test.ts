import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchProject, collectSamples, editYaml, harness } from "./harness.ts";

describe("Virtual Device → live Signals (MAVLink2)", () => {
  it("loads the Frame Format from the Project and lists its Devices and Signals", async () => {
    await using h = await harness();
    const c = await h.client();
    const { signals, path } = await benchProject(h, c);
    expect(await readFile(join(path, "frame-formats/bench.yaml"), "utf8")).toContain("framing: mavlink2");
    expect(await c.request("devices.list", {})).toEqual([
      { id: "bench", frameFormat: "frame-formats/bench.yaml", virtual: true, dialectHash: expect.stringMatching(/^[0-9a-f]{8}$/) },
    ]);
    const ids = signals.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "bench/HEARTBEAT.custom_mode",
        "bench/HEARTBEAT.mavlink_version",
        "bench/BENCH_STATE.time_us",
        "bench/BENCH_STATE.setpoint",
        "bench/BENCH_STATE.gyro_x",
        "bench/BENCH_STATE.gyro_y",
        "bench/BENCH_STATE.gyro_z",
        "bench/BENCH_STATE.mode",
        "bench/BENCH_ATTITUDE.roll",
        "bench/BENCH_ATTITUDE.pitch",
        "bench/BENCH_ATTITUDE.yaw",
        "bench/BENCH_ATTITUDE.q[0]",
        "bench/BENCH_ATTITUDE.q[1]",
        "bench/BENCH_ATTITUDE.q[2]",
        "bench/BENCH_ATTITUDE.q[3]",
      ]),
    );
    expect(signals.find((s) => s.id === "bench/BENCH_ATTITUDE.roll")?.units).toBe("rad");
    expect(signals.find((s) => s.id === "bench/BENCH_STATE.gyro_x")?.units).toBe("rad/s");
  });

  it("streams every frame the Virtual Device emits, decoded through MAVLink2", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await benchProject(h, c);
    const time = byId("bench/BENCH_STATE.time_us");
    const mode = byId("bench/BENCH_STATE.mode");
    const gyro = byId("bench/BENCH_STATE.gyro_x");
    await c.request("signals.subscribe", { ids: [time.id, mode.id, gyro.id] });
    await c.request("source.startVirtual", { device: "bench" });

    const s = await collectSamples(c, [time.handle, mode.handle, gyro.handle], (m) => m.get(time.handle)!.values.length >= 200);
    const ramp = s.get(time.handle)!.values;
    // ramp generator: 0, 2000, 4000, … — consecutive, no gaps, no duplicates
    expect(ramp[0]).toBe(0);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]! - ramp[i - 1]!).toBe(2000);
    expect(new Set(s.get(mode.handle)!.values)).toEqual(new Set([1]));
    for (const v of s.get(gyro.handle)!.values) expect(Math.abs(v)).toBeLessThanOrEqual(0.8 + 1e-6);
    // Host Timestamps are wall-clock milliseconds and never go backwards
    const times = s.get(time.handle)!.times;
    expect(Math.abs(times[0]! - Date.now())).toBeLessThan(5000);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
  });

  it("emits at the configured rate", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await benchProject(h, c);
    const time = byId("bench/BENCH_STATE.time_us");
    await c.request("signals.subscribe", { ids: [time.id] });
    await c.request("source.startVirtual", { device: "bench" });
    const t0 = Date.now();
    const s = await collectSamples(c, [time.handle], (m) => m.get(time.handle)!.values.length >= 500);
    const elapsed = (Date.now() - t0) / 1000;
    const rate = s.get(time.handle)!.values.length / elapsed;
    expect(rate).toBeGreaterThan(300);
    expect(rate).toBeLessThan(800);
  });

  it("qualifies Signal names by Device so identical Fields never collide", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    await editYaml(join(path, "project.yaml"), (doc) => {
      const second = structuredClone(doc.devices[0]);
      second.id = "bench2";
      second.virtual.messages.BENCH_STATE.fields.mode.value = 7;
      doc.devices.push(second);
    });
    await c.request("project.open", { path });
    const signals = await c.request("signals.list", {});
    const a = signals.find((x) => x.id === "bench/BENCH_STATE.mode")!;
    const b = signals.find((x) => x.id === "bench2/BENCH_STATE.mode")!;
    expect(a.handle).not.toBe(b.handle);
    await c.request("signals.subscribe", { ids: [a.id, b.id] });
    await c.request("source.startVirtual", { device: "bench" });
    await c.request("source.startVirtual", { device: "bench2" });
    const s = await collectSamples(c, [a.handle, b.handle], (m) => [...m.values()].every((x) => x.values.length >= 20));
    expect(new Set(s.get(a.handle)!.values)).toEqual(new Set([1]));
    expect(new Set(s.get(b.handle)!.values)).toEqual(new Set([7]));
  });

  it("broadcasts Source state and stops streaming when stopped", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await benchProject(h, c);
    const changes: string[] = [];
    c.on("source.changed", (s) => changes.push(`${s.device}:${s.state}`));
    const time = byId("bench/BENCH_STATE.time_us");
    await c.request("signals.subscribe", { ids: [time.id] });
    await c.request("source.startVirtual", { device: "bench" });
    await expect(c.request("source.startVirtual", { device: "bench" })).rejects.toMatchObject({ code: "conflict" });
    await collectSamples(c, [time.handle], (m) => m.get(time.handle)!.values.length > 0);
    expect(await c.request("sources.list", {})).toEqual([{ device: "bench", kind: "virtual", state: "running" }]);
    await c.request("source.stop", { device: "bench" });
    await new Promise((r) => setTimeout(r, 100));
    let after = 0;
    const off = c.onSignalChunk(() => after++);
    await new Promise((r) => setTimeout(r, 200));
    off();
    expect(after).toBe(0);
    expect(changes).toEqual(["bench:verifying", "bench:running", "bench:stopped"]);
    expect(await c.request("sources.list", {})).toEqual([]);
  });

  it("only sends Signals the client subscribed to", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await benchProject(h, c);
    const gyro = byId("bench/BENCH_STATE.gyro_x");
    await c.request("signals.subscribe", { ids: [gyro.id] });
    const seen = new Set<number>();
    c.onSignalChunk((chunk) => seen.add(chunk.handle));
    await c.request("source.startVirtual", { device: "bench" });
    await collectSamples(c, [gyro.handle], (m) => m.get(gyro.handle)!.values.length > 50);
    expect([...seen]).toEqual([gyro.handle]);
    await expect(c.request("signals.subscribe", { ids: ["bench/NOPE.x"] })).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports a Device whose Frame Format cannot be loaded", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    await writeFile(join(path, "dialects/bench.xml"), "<notmavlink/>");
    await c.request("project.open", { path });
    const [device] = await c.request("devices.list", {});
    expect(device?.error).toMatch(/MAVLink dialect/);
    await expect(c.request("source.startVirtual", { device: "bench" })).rejects.toMatchObject({ code: "invalid_project" });
  });

  it("requires an open Project", async () => {
    await using h = await harness();
    const c = await h.client();
    await expect(c.request("devices.list", {})).rejects.toMatchObject({ code: "no_project" });
    await expect(c.request("source.startVirtual", { device: "bench" })).rejects.toMatchObject({ code: "no_project" });
  });
});
