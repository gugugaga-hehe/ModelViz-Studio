import type { FieldGenerator, VirtualDeviceConfig } from "@modelviz/protocol";
import { type FrameFormat, defaultGenerator } from "./frame-format.ts";
import type { FieldValue } from "./mavlink/codec.ts";

/** How often the Virtual Device wakes up to emit the frames that have come due (ms). */
const TICK_MS = 5;
/** Upper bound on frames per tick, so a stalled event loop cannot trigger a burst storm. */
const MAX_FRAMES_PER_TICK = 2000;

interface MessagePlan {
  name: string;
  rateHz: number;
  emitted: number;
  fields: { name: string; arrayLength: number; gen: FieldGenerator }[];
}

function evaluate(gen: FieldGenerator, frameIndex: number, tSeconds: number): number {
  switch (gen.kind) {
    case "sine":
      return gen.offset + gen.amplitude * Math.sin(2 * Math.PI * gen.freqHz * tSeconds);
    case "ramp":
      return gen.start + gen.step * frameIndex;
    case "constant":
      return gen.value;
  }
}

/**
 * Simulates a Device by producing genuine Frame Format bytes on a timer. The bytes go
 * through the same decoding path as a real Transport, so nothing downstream can tell.
 */
export class VirtualDevice {
  private readonly plans: MessagePlan[];
  private readonly encode: (message: string, values: Record<string, FieldValue>) => Uint8Array;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  constructor(
    format: FrameFormat,
    config: VirtualDeviceConfig,
    private readonly onBytes: (bytes: Uint8Array) => void,
  ) {
    this.encode = format.createEncoder().encode;
    this.plans = Object.entries(config.messages).map(([name, m]) => {
      const spec = format.messages.find((s) => s.name === name);
      if (!spec) throw new Error(`Virtual Device emits unknown Message ${name}`);
      const numeric = spec.fields.filter((f) => f.numeric);
      return {
        name,
        rateHz: m.rateHz,
        emitted: 0,
        fields: numeric.map((f, i) => ({ name: f.name, arrayLength: f.arrayLength, gen: m.fields[f.name] ?? defaultGenerator(f, i) })),
      };
    });
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = performance.now();
    for (const p of this.plans) p.emitted = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const frames: Uint8Array[] = [];
    for (const p of this.plans) {
      const due = Math.min(Math.floor(elapsed * p.rateHz) + 1, p.emitted + MAX_FRAMES_PER_TICK);
      for (; p.emitted < due; p.emitted++) {
        const t = p.emitted / p.rateHz;
        const values: Record<string, FieldValue> = {};
        for (const f of p.fields) {
          const v = evaluate(f.gen, p.emitted, t);
          values[f.name] = f.arrayLength ? Array.from({ length: f.arrayLength }, (_, i) => v + i) : v;
        }
        frames.push(this.encode(p.name, values));
      }
    }
    if (!frames.length) return;
    const total = frames.reduce((n, f) => n + f.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const f of frames) {
      bytes.set(f, at);
      at += f.length;
    }
    this.onBytes(bytes);
  }
}
