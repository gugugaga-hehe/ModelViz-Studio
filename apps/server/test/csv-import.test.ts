import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { SourceState } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { collectSamples, harness } from "./harness.ts";

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

async function project(h: Awaited<ReturnType<typeof harness>>, c: ModelVizClient) {
  const path = join(h.dir, "p");
  await c.request("project.create", { path, name: "csv" });
  return path;
}

/** 2 s of data at 100 Hz: time [s], a = row index, b = sin(2π t). */
function csvText(sep = ",") {
  const rows = ["time" + sep + "a" + sep + "b"];
  for (let i = 0; i <= 200; i++) rows.push([(i / 100).toFixed(2), i, Math.sin((2 * Math.PI * i) / 100).toFixed(6)].join(sep));
  return rows.join("\n") + "\n";
}

describe("CSV import", () => {
  it("imports a CSV into the Project and exposes its columns as Signals", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = await project(h, c);
    const file = join(h.dir, "log.csv");
    await writeFile(file, csvText());
    const info = await c.request("csv.import", { path: file, name: "bench_log" });
    expect(info).toMatchObject({ id: "bench_log", device: "bench_log", format: "csv", durationMs: 2000, active: false });
    expect(await readFile(join(path, "imports/bench_log.csv"), "utf8")).toBe(csvText());
    expect(await readFile(join(path, "imports/bench_log.yaml"), "utf8")).toContain("timeUnit: s");

    const signals = await c.request("signals.list", {});
    expect(signals.map((s) => s.id)).toEqual(["bench_log/CSV.a", "bench_log/CSV.b"]);
    expect(await c.request("recordings.list", {})).toContainEqual(info);
    // imports are not Devices
    expect(await c.request("devices.list", {})).toEqual([]);

    // survives reopening the Project
    await c.request("project.open", { path });
    expect((await c.request("signals.list", {})).map((s) => s.id)).toEqual(["bench_log/CSV.a", "bench_log/CSV.b"]);
  });

  it("replays the CSV with its timing like any Log Replay", async () => {
    await using h = await harness();
    const c = await h.client();
    await project(h, c);
    const file = join(h.dir, "log.csv");
    await writeFile(file, csvText(";"));
    await c.request("csv.import", { path: file, name: "log" });
    const [a, b] = await c.request("signals.list", {});
    await c.request("signals.subscribe", { ids: [a!.id, b!.id] });
    const collecting = collectSamples(c, [a!.handle, b!.handle], (m) => m.get(a!.handle)!.values.length >= 201, 5000);
    const ended = waitForSource(c, (x) => x.replay?.playing === false && x.replay.positionMs === x.replay.durationMs);
    const st = await c.request("source.startReplay", { device: "log", recording: "log", speed: 4 });
    expect(st).toMatchObject({ kind: "replay", replay: { recording: "log", playing: true } });
    const s = await collecting;
    const av = s.get(a!.handle)!;
    expect(av.values).toEqual(Array.from({ length: 201 }, (_, i) => i));
    for (let i = 1; i < av.times.length; i++) expect(av.times[i]! - av.times[i - 1]!).toBeCloseTo(10, 6);
    const bv = s.get(b!.handle)!.values;
    expect(bv[25]).toBeCloseTo(1, 5);
    await ended;
    // the same controls work
    const seeked = await c.request("replay.control", { device: "log", action: "seek", positionMs: 1000 });
    expect(seeked.replay?.positionMs).toBe(1000);
    await c.request("source.stop", { device: "log" });
  });

  it("honours a named time column and unit", async () => {
    await using h = await harness();
    const c = await h.client();
    await project(h, c);
    const file = join(h.dir, "log.csv");
    await writeFile(file, "x,t_ms\n1,0\n2,5\n3,10\n");
    const info = await c.request("csv.import", { path: file, name: "ms", timeColumn: "t_ms", timeUnit: "ms" });
    expect(info.durationMs).toBe(10);
    expect((await c.request("signals.list", {})).map((s) => s.id)).toEqual(["ms/CSV.x"]);
  });

  it.each([
    ["header only", "time,a\n", /at least one data row/],
    ["non-numeric value", "time,a\n0,1\n0.1,oops\n", /line 3, column "a": "oops" is not a number/],
    ["ragged row", "time,a,b\n0,1,2\n0.1,1\n", /line 3: expected 3 values, found 2/],
    ["time going backwards", "time,a\n1,1\n0.5,2\n", /line 3: time goes backwards/],
    ["unknown time column", "time,a\n0,1\n", /no column "when"/],
  ])("rejects a malformed CSV: %s", async (_label, text, message) => {
    await using h = await harness();
    const c = await h.client();
    const path = await project(h, c);
    const file = join(h.dir, "bad.csv");
    await writeFile(file, text);
    const timeColumn = String(message).includes("when") ? "when" : undefined;
    await expect(c.request("csv.import", { path: file, name: "bad", ...(timeColumn ? { timeColumn } : {}) })).rejects.toThrow(message);
    await expect(readFile(join(path, "imports/bad.yaml"), "utf8")).rejects.toThrow();
  });

  it("reports a missing file and name clashes", async () => {
    await using h = await harness();
    const c = await h.client();
    await project(h, c);
    await expect(c.request("csv.import", { path: join(h.dir, "nope.csv"), name: "x" })).rejects.toMatchObject({ code: "not_found" });
    const file = join(h.dir, "log.csv");
    await writeFile(file, csvText());
    await c.request("csv.import", { path: file, name: "x" });
    await expect(c.request("csv.import", { path: file, name: "x" })).rejects.toMatchObject({ code: "already_exists" });
  });
});
