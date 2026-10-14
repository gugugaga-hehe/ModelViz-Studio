import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSamples, harness } from "./harness.ts";

const RATE_HZ = 8000;
const CHANNELS = 24;
/** Bytes per MAVLink2 frame: 10 header + 8 time + 24×4 floats + 2 CRC. */
const FRAME_BYTES = 10 + 8 + CHANNELS * 4 + 2;

describe("sustained throughput (ADR-0006)", () => {
  it(`streams ${RATE_HZ} Hz × ${CHANNELS} Fields (~${Math.round((RATE_HZ * FRAME_BYTES) / 1000)} kB/s) with zero loss`, async () => {
    await using h = await harness();
    const c = await h.client();
    const path = join(h.dir, "fast");
    await c.request("project.create", { path, name: "fast" });
    await mkdir(join(path, "dialects"));
    await copyFile(join(import.meta.dirname, "fixtures/throughput.xml"), join(path, "dialects/fast.xml"));
    await writeFile(
      join(path, "fast.yaml"),
      "framing: mavlink2\ndialect: dialects/fast.xml\nmessages:\n  FAST:\n    deviceTimestamp: { field: time_us, unit: us }\n    nominalRateHz: 8000\n",
    );
    const fields = Object.fromEntries(Array.from({ length: CHANNELS }, (_, i) => [`ch${i}`, { kind: "ramp", start: i, step: 1 }]));
    await writeFile(
      join(path, "project.yaml"),
      JSON.stringify({
        schemaVersion: 1,
        name: "fast",
        devices: [{ id: "fast", frameFormat: "fast.yaml", virtual: { messages: { FAST: { rateHz: RATE_HZ, fields } } } }],
      }),
    );
    await c.request("project.open", { path });
    const signals = (await c.request("signals.list", {})).filter((s) => s.field.startsWith("ch"));
    expect(signals).toHaveLength(CHANNELS);
    await c.request("signals.subscribe", { ids: signals.map((s) => s.id) });

    const seconds = 4;
    await c.request("source.startVirtual", { device: "fast" });
    const target = RATE_HZ * seconds;
    const t0 = Date.now();
    const got = await collectSamples(
      c,
      signals.map((s) => s.handle),
      (m) => [...m.values()].every((s) => s.values.length >= target),
      seconds * 1000 * 3,
    );
    const elapsed = (Date.now() - t0) / 1000;
    await c.request("source.stop", { device: "fast" });

    // keeps up with real time
    expect(elapsed).toBeLessThan(seconds * 1.5);
    // zero loss: every channel is an unbroken ramp with exact 125 µs Device intervals
    signals.forEach((s, ch) => {
      const { values, times } = got.get(s.handle)!;
      for (let i = 0; i < target; i++) {
        if (values[i] !== ch + i) throw new Error(`${s.id}: sample ${i} is ${values[i]}, expected ${ch + i}`);
      }
      for (let i = 1; i < target; i++) {
        if (Math.abs(times[i]! - times[i - 1]! - 0.125) > 1e-6) throw new Error(`${s.id}: gap at ${i}`);
      }
    });
    const health = await c.request("link.health", { device: "fast" });
    expect(health).toMatchObject({ crcErrors: 0, sequenceGaps: 0, discardedBytes: 0 });
    expect(health.messages.FAST).toMatchObject({ missedFrames: 0, timingJumps: 0 });
  }, 30000);
});
