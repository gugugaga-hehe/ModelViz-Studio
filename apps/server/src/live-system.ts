import type { LiveSystemState } from "@modelviz/protocol";
import type { PythonHost } from "./model/python-host.ts";
import type { SystemEngine } from "./model/system.ts";

/** How often a live System catches up with its input Signal (one chunk of latency, ADR-0010). */
export const LIVE_CHUNK_MS = 50;

/**
 * Runs a System continuously from a live Signal. Every chunk interval it simulates all System
 * samples up to the newest input sample, holding the input between its samples, and publishes
 * outputs on the input Signal's own time axis so model and measurement line up in plots.
 */
export class LiveSystem {
  private readonly times: number[] = [];
  private readonly values: number[] = [];
  /** Time (ms) of System sample 0, set by the first input sample. */
  private t0: number | null = null;
  private k = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private error: string | undefined;
  private untap: () => void;

  constructor(
    readonly system: string,
    readonly input: string,
    readonly signal: string,
    private readonly engine: SystemEngine,
    private readonly host: PythonHost | null,
    tap: (fn: (time: number, value: number) => void) => () => void,
    private readonly publish: (output: string, time: number, value: number) => void,
    private readonly onChange: (s: LiveSystemState) => void,
  ) {
    this.untap = tap((time, value) => {
      this.t0 ??= time;
      this.times.push(time);
      this.values.push(value);
    });
    this.timer = setInterval(() => void this.step(), LIVE_CHUNK_MS);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  state(): LiveSystemState {
    return {
      system: this.system,
      input: this.input,
      signal: this.signal,
      running: this.running,
      samples: this.k,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.untap();
    this.host?.close();
    this.onChange(this.state());
  }

  private async step(): Promise<void> {
    if (this.busy || this.t0 === null || !this.times.length) return;
    this.busy = true;
    try {
      const fs = this.engine.sampleRateHz;
      const dtMs = 1000 / fs;
      const newest = this.times.at(-1)!;
      const count = Math.floor((newest - this.t0) / dtMs) + 1 - this.k;
      if (count <= 0) return;
      // drop input samples no longer needed (keep the one that holds at the chunk start)
      const startT = this.t0 + this.k * dtMs;
      let drop = 0;
      while (drop + 1 < this.times.length && this.times[drop + 1]! <= startT) drop++;
      this.times.splice(0, drop);
      this.values.splice(0, drop);
      let i = 0;
      const out = await this.engine.run(count, (name, kk) => {
        if (name !== this.input) return 0;
        const t = this.t0! + kk * dtMs;
        while (i + 1 < this.times.length && this.times[i + 1]! <= t) i++;
        return this.values[i]!;
      });
      this.engine.outputs.forEach((o, j) => {
        const ys = out[j]!;
        for (let n = 0; n < count; n++) this.publish(o, this.t0! + (this.k + n) * dtMs, ys[n]!);
      });
      this.k += count;
    } catch (e) {
      this.error = (e as Error).message;
      this.stop();
    } finally {
      this.busy = false;
    }
  }
}
