import { MAX_TIME_SAMPLES } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { benchProject, harness } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("long time-domain Analyses", () => {
  it("keep live Signals streaming and requests answered while they run", async () => {
    await using h = await harness();
    const c = await h.client();
    const { byId } = await benchProject(h, c);
    await c.request("source.startVirtual", { device: "bench" });
    const setpoint = byId("bench/BENCH_STATE.setpoint");
    await c.request("signals.subscribe", { ids: [setpoint.id] });

    const progress: number[] = [];
    c.on("analysis.progress", (p) => p.id === "long" && progress.push(p.done / p.total));
    let finished = false;
    const run = c.request("analysis.time", { id: "long", system: "systems/rate_loop.yaml", kind: "step", durationS: 300 });
    void run.then(
      () => (finished = true),
      () => (finished = true),
    );
    await sleep(100);

    // while it runs: live chunks arrive and another request is answered promptly
    let chunks = 0;
    const off = c.onSignalChunk((ch) => ch.handle === setpoint.handle && chunks++);
    await sleep(500);
    off();
    const asked = performance.now();
    await c.request("project.current", {});
    const answeredMs = performance.now() - asked;
    expect(finished).toBe(false);
    expect(chunks).toBeGreaterThan(5);
    expect(answeredMs).toBeLessThan(200);
    expect(progress.length).toBeGreaterThan(0);

    // cancelling stops it between chunks
    await c.request("analysis.cancel", { id: "long" });
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
  });

  it("refuses runs over the sample budget", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    // rate_loop runs at 1 kHz: one hour is 3.6 M samples
    await expect(c.request("analysis.time", { system: "systems/rate_loop.yaml", kind: "step", durationS: 3600 })).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining(`at most ${MAX_TIME_SAMPLES}`),
    });
  });
});
