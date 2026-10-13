import type { LinkHealth, MessageHealth } from "@modelviz/protocol";
import type { FrameDecoder, FrameFormat, MessageSpec } from "./frame-format.ts";

/** A Device Timestamp gap this many nominal periods (or going backwards) counts as a timing jump. */
const JUMP_PERIODS = 50;
/** Device time going back by more than this re-anchors the clock (the Device rebooted). */
const RESET_BACKWARDS_MS = 1000;
/** Measured-vs-nominal rate tolerance before flagging a deviation. */
const RATE_TOLERANCE = 0.1;

export interface SignalTarget {
  field: string;
  /** Element index for array Fields that are not batched. */
  index: number;
  handle: number;
  /** Array Field whose elements are consecutive samples. */
  batched: boolean;
}

export type Publish = (handle: number, time: number, value: number, hostTime: number | null) => void;

interface MessageMonitor {
  frames: number;
  framesInWindow: number;
  lastDeviceMs: number | null;
  missedFrames: number;
  timingJumps: number;
  rateHz: number;
}

/**
 * Turns one Device's byte stream into timestamped samples: decodes frames, expands batched
 * samples, applies Device Timestamps (anchored to the host clock) and watches link health.
 */
export class DeviceLink {
  private readonly decoder: FrameDecoder;
  private readonly specs: Map<string, MessageSpec>;
  private readonly monitors = new Map<string, MessageMonitor>();
  /** host ms − device ms, fixed at the first Device Timestamp (re-anchored on reset). */
  private clockOffset: number | null = null;
  private lastDeviceMs = -Infinity;
  private windowStart = performance.now();

  constructor(
    readonly device: string,
    format: FrameFormat,
    private readonly targets: Map<string, SignalTarget[]>,
    private readonly publish: Publish,
  ) {
    this.decoder = format.createDecoder();
    this.specs = new Map(format.messages.map((m) => [m.name, m]));
  }

  ingest(bytes: Uint8Array): void {
    const hostTime = Date.now();
    for (const msg of this.decoder.push(bytes)) {
      const spec = this.specs.get(msg.message);
      const targets = this.targets.get(msg.message);
      if (!spec) continue;
      const mon = this.monitor(msg.message);
      mon.frames++;
      mon.framesInWindow++;

      let time = hostTime;
      let host: number | null = null;
      let intervalMs = 0;
      if (spec.deviceTimestamp) {
        const deviceMs = Number(msg.values[spec.deviceTimestamp.field]) * spec.deviceTimestamp.toMs;
        this.checkTiming(spec, mon, deviceMs);
        time = this.anchor(deviceMs, hostTime);
        host = hostTime;
        const b = spec.batch;
        if (b) intervalMs = b.intervalMs ?? Number(msg.values[b.intervalField!.field]) * b.intervalField!.toMs;
      }
      for (const t of targets ?? []) {
        const v = msg.values[t.field];
        if (t.batched && Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) this.publish(t.handle, time + i * intervalMs, v[i]!, host);
        } else {
          const n = Array.isArray(v) ? v[t.index] : v;
          if (typeof n === "number") this.publish(t.handle, time, n, host);
        }
      }
    }
  }

  health(): LinkHealth {
    const now = performance.now();
    const seconds = (now - this.windowStart) / 1000;
    if (seconds >= 0.5) {
      for (const m of this.monitors.values()) {
        m.rateHz = m.framesInWindow / seconds;
        m.framesInWindow = 0;
      }
      this.windowStart = now;
    }
    const s = this.decoder.stats;
    const messages: Record<string, MessageHealth> = {};
    for (const [name, m] of this.monitors) {
      const nominal = this.specs.get(name)?.nominalRateHz;
      messages[name] = {
        frames: m.frames,
        rateHz: m.rateHz,
        ...(nominal ? { nominalRateHz: nominal } : {}),
        missedFrames: m.missedFrames,
        timingJumps: m.timingJumps,
        rateDeviation: nominal !== undefined && m.rateHz > 0 && Math.abs(m.rateHz - nominal) / nominal > RATE_TOLERANCE,
      };
    }
    return {
      device: this.device,
      frames: s.frames,
      crcErrors: s.crcErrors,
      sequenceGaps: s.sequenceGaps,
      unknownMessages: s.unknownMessages,
      discardedBytes: s.discardedBytes,
      messages,
    };
  }

  private monitor(name: string): MessageMonitor {
    let m = this.monitors.get(name);
    if (!m) {
      m = { frames: 0, framesInWindow: 0, lastDeviceMs: null, missedFrames: 0, timingJumps: 0, rateHz: 0 };
      this.monitors.set(name, m);
    }
    return m;
  }

  private checkTiming(spec: MessageSpec, mon: MessageMonitor, deviceMs: number): void {
    const last = mon.lastDeviceMs;
    mon.lastDeviceMs = deviceMs;
    if (last === null || !spec.nominalRateHz) return;
    const period = 1000 / spec.nominalRateHz;
    const gap = deviceMs - last;
    if (gap <= 0 || gap > JUMP_PERIODS * period) mon.timingJumps++;
    else mon.missedFrames += Math.max(0, Math.round(gap / period) - 1);
  }

  /** Maps Device time onto the host clock with a constant offset, so Device intervals stay exact. */
  private anchor(deviceMs: number, hostTime: number): number {
    if (this.clockOffset === null || deviceMs < this.lastDeviceMs - RESET_BACKWARDS_MS) {
      this.clockOffset = hostTime - deviceMs;
    }
    this.lastDeviceMs = Math.max(this.lastDeviceMs, deviceMs);
    return deviceMs + this.clockOffset;
  }
}
