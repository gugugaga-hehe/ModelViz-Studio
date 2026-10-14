import type { FieldGenerator, ParameterType, VirtualDeviceConfig, VirtualFaults, VirtualParameter } from "@modelviz/protocol";
import { type FrameDecoder, type FrameFormat, type MessageSpec, type ParameterProtocol, type ParameterStore, defaultGenerator } from "./frame-format.ts";
import type { FieldValue } from "./mavlink/codec.ts";

/** How often the Virtual Device wakes up to emit the frames that have come due (ms). */
const TICK_MS = 5;
/** Upper bound on frames per tick, so a stalled event loop cannot trigger a burst storm. */
const MAX_FRAMES_PER_TICK = 2000;

interface FieldPlan {
  name: string;
  arrayLength: number;
  gen: FieldGenerator;
  /** Elements are consecutive samples rather than independent values. */
  batched: boolean;
}

interface MessagePlan {
  spec: MessageSpec;
  rateHz: number;
  emitted: number;
  fields: FieldPlan[];
  /** Interval between batched samples (ms). */
  sampleIntervalMs: number;
  /** Field auto-filled with the correct dialect hash. */
  dialectHashField?: { field: string; value: number };
}

function evaluate(gen: FieldGenerator, index: number, tSeconds: number): number {
  switch (gen.kind) {
    case "sine":
      return gen.offset + gen.amplitude * Math.sin(2 * Math.PI * gen.freqHz * tSeconds);
    case "ramp":
      return gen.start + gen.step * index;
    case "constant":
      return gen.value;
  }
}

const TYPE_RANGE: Partial<Record<ParameterType, [number, number]>> = {
  uint8: [0, 255],
  int8: [-128, 127],
  uint16: [0, 65535],
  int16: [-32768, 32767],
  uint32: [0, 4294967295],
  int32: [-2147483648, 2147483647],
};

/**
 * A firmware-like parameter store: integer writes are truncated as a C cast would, and writes
 * that are read-only or outside the declared range are ignored, so the old value is reported.
 */
class SimulatedParameters implements ParameterStore {
  private readonly params: { name: string; type: ParameterType; value: number; spec: VirtualParameter }[];

  constructor(config: Record<string, VirtualParameter>, maxNameLength: number) {
    this.params = Object.entries(config).map(([name, spec]) => {
      if (name.length > maxNameLength) throw new Error(`Device Parameter name ${name} is longer than ${maxNameLength} characters`);
      return { name, type: spec.type, value: this.cast(spec.type, spec.value), spec };
    });
  }

  entries() {
    return this.params.map(({ name, type, value }) => ({ name, type, value }));
  }

  set(name: string, value: number): void {
    const p = this.params.find((x) => x.name === name);
    if (!p || p.spec.readOnly) return;
    const v = this.cast(p.type, value);
    const range = TYPE_RANGE[p.type];
    if (range && (v < range[0] || v > range[1])) return;
    if ((p.spec.min !== undefined && v < p.spec.min) || (p.spec.max !== undefined && v > p.spec.max)) return;
    p.value = v;
  }

  private cast(type: ParameterType, value: number): number {
    return type === "float" ? Math.fround(value) : Math.trunc(value);
  }
}

/**
 * Simulates a Device by producing genuine Frame Format bytes on a timer. The bytes go
 * through the same decoding path as a real Transport, so nothing downstream can tell.
 *
 * Device Timestamp and batch-interval Fields without an explicit generator are filled
 * from the Virtual Device's own clock, so their values are exact.
 */
export class VirtualDevice {
  private readonly plans: MessagePlan[];
  private readonly encode: (message: string, values: Record<string, FieldValue>) => Uint8Array;
  private readonly faults: VirtualFaults;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private frameCount = 0;
  private lastDeliveryAt = 0;
  /** Jittered chunks waiting for delivery, oldest first; one timer drains them in order. */
  private readonly queue: { at: number; bytes: Uint8Array }[] = [];
  private deliveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Inbound side: requests from the workbench, answered from the simulated parameter store. */
  private readonly inbound: { decoder: FrameDecoder; protocol: ParameterProtocol; store: SimulatedParameters } | null;

  constructor(
    format: FrameFormat,
    config: VirtualDeviceConfig,
    private readonly onBytes: (bytes: Uint8Array) => void,
  ) {
    this.encode = format.createEncoder().encode;
    this.faults = config.faults ?? {};
    const protocol = format.parameters;
    this.inbound = protocol
      ? { decoder: format.createDecoder(), protocol, store: new SimulatedParameters(config.parameters ?? {}, protocol.maxNameLength) }
      : null;
    this.plans = Object.entries(config.messages).map(([name, m]) => {
      const spec = format.messages.find((s) => s.name === name);
      if (!spec) throw new Error(`Virtual Device emits unknown Message ${name}`);
      const check = format.dialectCheck?.message === name ? format.dialectCheck.field : undefined;
      const auto = new Set([spec.deviceTimestamp?.field, spec.batch?.intervalField?.field, check].filter(Boolean));
      const numeric = spec.fields.filter((f) => f.numeric && !(auto.has(f.name) && !m.fields[f.name]));
      const batchLength = spec.batch?.length ?? 1;
      return {
        spec,
        ...(check && !m.fields[check] ? { dialectHashField: { field: check, value: parseInt(format.dialectHash, 16) } } : {}),
        rateHz: m.rateHz,
        emitted: 0,
        sampleIntervalMs: spec.batch?.intervalMs ?? 1000 / (m.rateHz * batchLength),
        fields: numeric.map((f, i) => ({
          name: f.name,
          arrayLength: f.arrayLength,
          gen: m.fields[f.name] ?? defaultGenerator(f, i),
          batched: spec.batch?.fields.includes(f.name) ?? false,
        })),
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
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.deliveryTimer = null;
    this.queue.length = 0;
  }

  /** Bytes sent to the Device. Answers are emitted asynchronously, like a real Device's. */
  receive(bytes: Uint8Array): void {
    const io = this.inbound;
    if (!io) return;
    const answers = io.decoder.push(bytes).flatMap((msg) => io.protocol.serve(msg, io.store));
    if (!answers.length) return;
    setImmediate(() => {
      if (!this.timer) return;
      const frames = answers.map((a) => this.withFaults(this.encode(a.message, a.values))).filter((f) => f !== null);
      if (frames.length) this.deliver(concat(frames));
    });
  }

  /** Applies the configured drop and corruption faults; null when the frame is dropped. */
  private withFaults(frame: Uint8Array): Uint8Array | null {
    const n = this.frameCount++;
    if (this.faults.dropEvery && n % this.faults.dropEvery === this.faults.dropEvery - 1) return null;
    if (this.faults.corruptEvery && n % this.faults.corruptEvery === this.faults.corruptEvery - 1) {
      frame[frame.length - 3]! ^= 0xff;
    }
    return frame;
  }

  private frameValues(p: MessagePlan): Record<string, FieldValue> {
    const frameTimeMs = (p.emitted / p.rateHz) * 1000;
    const values: Record<string, FieldValue> = {};
    const ts = p.spec.deviceTimestamp;
    if (ts) values[ts.field] = frameTimeMs / ts.toMs;
    const iv = p.spec.batch?.intervalField;
    if (iv) values[iv.field] = p.sampleIntervalMs / iv.toMs;
    if (p.dialectHashField) values[p.dialectHashField.field] = p.dialectHashField.value;
    for (const f of p.fields) {
      if (f.batched) {
        values[f.name] = Array.from({ length: f.arrayLength }, (_, i) => {
          const k = p.emitted * f.arrayLength + i;
          return evaluate(f.gen, k, (frameTimeMs + i * p.sampleIntervalMs) / 1000);
        });
      } else {
        const v = evaluate(f.gen, p.emitted, frameTimeMs / 1000);
        values[f.name] = f.arrayLength ? Array.from({ length: f.arrayLength }, (_, i) => v + i) : v;
      }
    }
    return values;
  }

  private tick(): void {
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const frames: Uint8Array[] = [];
    for (const p of this.plans) {
      const due = Math.min(Math.floor(elapsed * p.rateHz) + 1, p.emitted + MAX_FRAMES_PER_TICK);
      for (; p.emitted < due; p.emitted++) {
        const frame = this.withFaults(this.encode(p.spec.name, this.frameValues(p)));
        if (frame) frames.push(frame);
      }
    }
    if (frames.length) this.deliver(concat(frames));
  }

  /** Hands bytes over, optionally after a random delay; delivery order is always preserved. */
  private deliver(bytes: Uint8Array): void {
    const jitter = this.faults.jitterMs ?? 0;
    if (!jitter) {
      this.onBytes(bytes);
      return;
    }
    this.lastDeliveryAt = Math.max(this.lastDeliveryAt, performance.now() + Math.random() * jitter);
    this.queue.push({ at: this.lastDeliveryAt, bytes });
    this.scheduleDelivery();
  }

  private scheduleDelivery(): void {
    if (this.deliveryTimer || !this.queue.length) return;
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = null;
      const now = performance.now();
      while (this.queue.length && this.queue[0]!.at <= now) this.onBytes(this.queue.shift()!.bytes);
      this.scheduleDelivery();
    }, Math.max(0, this.queue[0]!.at - performance.now()));
  }
}

function concat(frames: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    bytes.set(f, at);
    at += f.length;
  }
  return bytes;
}
