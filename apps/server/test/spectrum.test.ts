import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { SpectrumResult } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { benchProject, collectSamples, harness } from "./harness.ts";

type Tone = { hz: number; amplitude: number };

/** Evenly sampled multi-tone Signal: times in ms. */
function tones(fs: number, n: number, list: Tone[], offset = 0, jitter = 0): { times: number[]; values: number[] } {
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
  const times: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    times.push(t * 1000 + jitter * rand() * (1000 / fs));
    values.push(offset + list.reduce((v, s) => v + s.amplitude * Math.sin(2 * Math.PI * s.hz * t), 0));
  }
  return { times, values };
}

/** Largest local maximum of the amplitude spectrum within ±2 Hz of `hz`. */
function peak(r: SpectrumResult, hz: number): { hz: number; amplitude: number } {
  let best = { hz: NaN, amplitude: -Infinity };
  r.frequencies.forEach((f, k) => {
    if (Math.abs(f - hz) <= 2 && r.amplitude[k]! > best.amplitude) best = { hz: f, amplitude: r.amplitude[k]! };
  });
  return best;
}

const at = (r: SpectrumResult, hz: number) => r.amplitude[Math.round(hz / r.resolutionHz)]!;

describe("FFT/PSD", () => {
  it("shows a known multi-tone Signal's peaks at the right frequencies and levels", async () => {
    await using h = await harness();
    const c = await h.client();
    const list = [
      { hz: 50, amplitude: 1 },
      { hz: 120, amplitude: 0.5 },
      { hz: 200.3, amplitude: 0.25 },
    ];
    const r = await c.request("analysis.spectrum", { ...tones(1000, 4096, list, 3), window: "flattop", length: 4096 });
    expect(r).toMatchObject({ sampleRateHz: 1000, length: 4096, samples: 4096, window: "flattop" });
    expect(r.resolutionHz).toBeCloseTo(1000 / 4096, 9);
    expect(r.frequencies.at(-1)).toBe(500);
    for (const tone of list) {
      const p = peak(r, tone.hz);
      expect(Math.abs(p.hz - tone.hz)).toBeLessThanOrEqual(r.resolutionHz);
      // flat top windows read sine amplitudes between bins to within a fraction of a percent
      expect(p.amplitude).toBeCloseTo(tone.amplitude, 2);
    }
    // the DC offset of 3 was removed (what remains is the tones' leakage into the DC bin)
    expect(r.amplitude[0]).toBeLessThan(0.01);
    // no other peaks: between the tones the spectrum is far below them
    expect(at(r, 85)).toBeLessThan(1e-3);
  });

  it("scales the PSD so it integrates to the Signal's variance", async () => {
    await using h = await harness();
    const c = await h.client();
    // a bin-centred sine with a Hann window: amplitude exact, power A²/2
    const fs = 1024;
    const r = await c.request("analysis.spectrum", { ...tones(fs, 1024, [{ hz: 64, amplitude: 2 }]), window: "hann", length: 1024 });
    expect(at(r, 64)).toBeCloseTo(2, 9);
    const power = r.psd.reduce((a, p) => a + p * r.resolutionHz, 0);
    expect(power).toBeCloseTo(2, 2);
    expect(r.enbwHz).toBeCloseTo(1.5, 6); // Hann: 1.5 bins
  });

  it("offers selectable window functions and lengths", async () => {
    await using h = await harness();
    const c = await h.client();
    const signal = tones(1000, 8192, [{ hz: 100.37, amplitude: 1 }]);
    const run = (window: "rectangular" | "hann" | "hamming" | "blackman" | "flattop", length: number) =>
      c.request("analysis.spectrum", { ...signal, window, length });

    // leakage 30 Hz away from an off-bin tone: each window suppresses it differently
    const leak = async (w: Parameters<typeof run>[0]) => at(await run(w, 4096), 130);
    const [rect, hann, blackman] = [await leak("rectangular"), await leak("hann"), await leak("blackman")];
    expect(rect).toBeGreaterThan(1e-4);
    expect(hann).toBeLessThan(rect / 100);
    expect(blackman).toBeLessThan(hann);
    expect((await run("hamming", 4096)).window).toBe("hamming");

    // the length sets the resolution; only the newest samples are used
    for (const length of [256, 1024, 8192]) {
      const r = await run("hann", length);
      expect(r).toMatchObject({ length, samples: length });
      expect(r.frequencies).toHaveLength(length / 2 + 1);
      expect(Math.abs(peak(r, 100.37).hz - 100.37)).toBeLessThanOrEqual(r.resolutionHz);
    }
    // fewer samples than the length: zero-padded, amplitude still right
    const short = await c.request("analysis.spectrum", { ...tones(1000, 3000, [{ hz: 100, amplitude: 1 }]), window: "flattop", length: 4096 });
    expect(short.samples).toBe(3000);
    expect(peak(short, 100).amplitude).toBeCloseTo(1, 2);

    await expect(run("hann", 1000)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(c.request("analysis.spectrum", { times: [1, 2, 3], values: [1, 2, 3], length: 256 })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(c.request("analysis.spectrum", { times: signal.times, values: signal.values.slice(1), length: 256 })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("handles jittery Host Timestamps by resampling onto a uniform grid", async () => {
    await using h = await harness();
    const c = await h.client();
    const r = await c.request("analysis.spectrum", { ...tones(500, 2048, [{ hz: 31, amplitude: 1 }], 0, 0.3), window: "flattop", length: 2048 });
    expect(r.sampleRateHz).toBeCloseTo(500, -1);
    const p = peak(r, 31);
    expect(Math.abs(p.hz - 31)).toBeLessThanOrEqual(2 * r.resolutionHz);
    expect(p.amplitude).toBeCloseTo(1, 1);
  });
});

describe("FFT/PSD of every kind of Signal", () => {
  /** Collects `n` samples of a Signal through the client protocol, as a Panel would. */
  async function collect(c: ModelVizClient, id: string, n: number, start: () => Promise<unknown>, timeoutMs = 10000) {
    const s = (await c.request("signals.list", {})).find((x) => x.id === id)!;
    await c.request("signals.subscribe", { ids: [id] });
    const done = collectSamples(c, [s.handle], (m) => m.get(s.handle)!.values.length >= n, timeoutMs);
    await start();
    const got = (await done).get(s.handle)!;
    return { times: got.times.slice(-n), values: got.values.slice(-n) };
  }

  it("works on live telemetry", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    // the bench's batched gyro_x is a 7 Hz sine of amplitude 1 sampled at 1 kHz
    const data = await collect(c, "bench/BENCH_IMU_BATCH.gyro_x", 2048, () => c.request("source.startVirtual", { device: "bench" }));
    const r = await c.request("analysis.spectrum", { ...data, window: "flattop", length: 2048 });
    expect(r.sampleRateHz).toBeCloseTo(1000, 3);
    expect(Math.abs(peak(r, 7).hz - 7)).toBeLessThanOrEqual(r.resolutionHz);
    expect(peak(r, 7).amplitude).toBeCloseTo(1, 1);
  });

  it("works on a Log Replay", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    const { times, values } = tones(200, 2001, [
      { hz: 5, amplitude: 1.5 },
      { hz: 23, amplitude: 0.5 },
    ]);
    const file = join(h.dir, "vib.csv");
    await writeFile(file, "t,y\n" + times.map((t, i) => `${t / 1000},${values[i]}`).join("\n") + "\n");
    await c.request("csv.import", { path: file, name: "vib" });
    const data = await collect(c, "vib/CSV.y", 2001, () => c.request("source.startReplay", { device: "vib", recording: "vib", speed: 8 }));
    const r = await c.request("analysis.spectrum", { ...data, window: "flattop", length: 2048 });
    expect(r.sampleRateHz).toBeCloseTo(200, 6);
    expect(peak(r, 5).amplitude).toBeCloseTo(1.5, 1);
    expect(peak(r, 23).amplitude).toBeCloseTo(0.5, 1);
  });

  it("works on model output", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    await writeFile(join(path, "blocks/double.yaml"), "kind: formula\noutputs:\n  y: 2*u\nlinear: true\n");
    await writeFile(
      join(path, "systems/double.yaml"),
      "sampleRateHz: 500\ninputs: [r]\nblocks:\n  g: { block: blocks/double.yaml }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n",
    );
    await c.request("project.open", { path });
    const data = await collect(c, "system:double/out.y", 2001, () =>
      c.request("analysis.time", { system: "systems/double.yaml", kind: "stimulus", stimulus: { kind: "sine", freqHz: 10, amplitude: 1 }, durationS: 4 }),
    );
    const r = await c.request("analysis.spectrum", { ...data, window: "flattop", length: 2048 });
    expect(r.sampleRateHz).toBeCloseTo(500, 6);
    expect(Math.abs(peak(r, 10).hz - 10)).toBeLessThanOrEqual(r.resolutionHz);
    expect(peak(r, 10).amplitude).toBeCloseTo(2, 1);
  });
});
