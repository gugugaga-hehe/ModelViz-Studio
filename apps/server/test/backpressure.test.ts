import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { harness } from "./harness.ts";

const RATE_HZ = 8000;
const CHANNELS = 24;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Signal bus backpressure", () => {
  it("skips chunks for a client that stops reading and reports what it missed", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = join(h.dir, "fast");
    await c.request("project.create", { path, name: "fast" });
    await mkdir(join(path, "dialects"));
    await copyFile(join(import.meta.dirname, "fixtures/throughput.xml"), join(path, "dialects/fast.xml"));
    await writeFile(
      join(path, "fast.yaml"),
      `framing: mavlink2\ndialect: dialects/fast.xml\nmessages:\n  FAST:\n    deviceTimestamp: { field: time_us, unit: us }\n    nominalRateHz: ${RATE_HZ}\n`,
    );
    const fields = Object.fromEntries(Array.from({ length: CHANNELS }, (_, i) => [`ch${i}`, { kind: "ramp", start: i, step: 1 }]));
    await writeFile(
      join(path, "project.yaml"),
      JSON.stringify({ schemaVersion: 1, name: "fast", devices: [{ id: "fast", frameFormat: "fast.yaml", virtual: { messages: { FAST: { rateHz: RATE_HZ, fields } } } }] }),
    );
    await c.request("project.open", { path });
    const ids = (await c.request("signals.list", {})).filter((s) => s.field.startsWith("ch")).map((s) => s.id);

    // a raw client whose socket can be paused, like a browser tab that stops reading
    const slow = new WebSocket(h.server.wsUrl);
    let binaryBytes = 0;
    let dropped: { id: string; samples: number }[] | null = null;
    const replies = new Map<number, unknown>();
    slow.on("message", (data, isBinary) => {
      if (isBinary) {
        binaryBytes += (data as Buffer).length;
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === "response") replies.set(msg.id, msg);
      if (msg.type === "event" && msg.event === "signals.dropped") dropped = msg.data.signals;
    });
    await new Promise((r) => slow.once("open", r));
    slow.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
    slow.send(JSON.stringify({ type: "request", id: 1, method: "signals.subscribe", params: { ids } }));
    await expect.poll(() => replies.has(1)).toBe(true);

    await c.request("source.startVirtual", { device: "fast" });
    await sleep(300);
    slow.pause();
    const pausedMs = 4000;
    await sleep(pausedMs);
    const before = binaryBytes;
    slow.resume();
    await expect.poll(() => dropped, { timeout: 5000 }).not.toBeNull();
    const afterResume = binaryBytes - before;
    await c.request("source.stop", { device: "fast" });
    slow.close();

    // every Signal reports skipped samples…
    expect(new Set(dropped!.map((d) => d.id))).toEqual(new Set(ids));
    const skipped = dropped!.reduce((n, d) => n + d.samples, 0);
    expect(skipped).toBeGreaterThan(0);
    // …and what was queued while paused stayed well below what the Device produced meanwhile
    const produced = (RATE_HZ * CHANNELS * pausedMs) / 1000;
    const bytesPerSample = 16;
    expect(afterResume).toBeLessThan(0.6 * produced * bytesPerSample);
  });
});
