import { z } from "zod";
import { TransportConfig } from "./project.ts";

/**
 * Signal names are `<device>/<Message>.<Field>`; array Fields expand to `<Field>[i]`.
 * Qualifying by Device keeps identically named Fields on different Devices apart.
 */
export function signalId(device: string, message: string, field: string): string {
  return `${device}/${message}.${field}`;
}

export const SignalInfo = z.object({
  id: z.string(),
  device: z.string(),
  message: z.string(),
  field: z.string(),
  /** Numeric handle used in binary Signal chunks. */
  handle: z.number().int(),
  units: z.string().optional(),
  /** Whether sample times come from the Device Timestamp or from Host Timestamps. */
  timebase: z.enum(["device", "host"]),
});
export type SignalInfo = z.infer<typeof SignalInfo>;

export const DeviceInfo = z.object({
  id: z.string(),
  frameFormat: z.string(),
  /** Whether the Device can be run as a Virtual Device. */
  virtual: z.boolean(),
  /** Problem loading the Device's Frame Format, if any. */
  error: z.string().optional(),
  /** Hash the Device must report when the Frame Format declares a dialect check (hex). */
  dialectHash: z.string().optional(),
  transport: TransportConfig.optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const MessageHealth = z.object({
  frames: z.number(),
  /** Frames per second over the last report interval. */
  rateHz: z.number(),
  nominalRateHz: z.number().optional(),
  /** Frames inferred missing from Device Timestamp gaps. */
  missedFrames: z.number(),
  /** Device Timestamp going backwards or leaping far beyond the Nominal Rate. */
  timingJumps: z.number(),
  /** Measured rate differs from the Nominal Rate by more than 10%. */
  rateDeviation: z.boolean(),
});
export type MessageHealth = z.infer<typeof MessageHealth>;

export const LinkHealth = z.object({
  device: z.string(),
  frames: z.number(),
  crcErrors: z.number(),
  /** Frames lost according to the Framing's sequence numbers. */
  sequenceGaps: z.number(),
  unknownMessages: z.number(),
  discardedBytes: z.number(),
  messages: z.record(z.string(), MessageHealth),
});
export type LinkHealth = z.infer<typeof LinkHealth>;

export const SourceKind = z.enum(["virtual", "serial", "tcp", "udp"]);
export type SourceKind = z.infer<typeof SourceKind>;

/**
 * - `connecting`: Transport opening (or reopening after `lost`)
 * - `verifying`: connected, waiting for the Device's dialect hash
 * - `running`: telemetry flowing
 * - `lost`: Transport dropped; reconnecting automatically
 * - `rejected`: refused (e.g. dialect hash mismatch); see `error`
 * - `stopped`: stopped by the user
 */
export const SourceStatus = z.enum(["connecting", "verifying", "running", "lost", "rejected", "stopped"]);
export type SourceStatus = z.infer<typeof SourceStatus>;

export const SourceState = z.object({
  device: z.string(),
  kind: SourceKind,
  state: SourceStatus,
  transport: TransportConfig.optional(),
  error: z.string().optional(),
});
export type SourceState = z.infer<typeof SourceState>;

// ---- Binary Signal chunk -----------------------------------------------------
//
// Layout (little-endian), 8-byte aligned so arrays can be viewed without copying:
//   u8  kind = 1
//   u8  flags          bit 0: hostTimes present
//   u16 handle
//   u32 count
//   f64 times[count]       milliseconds, Unix epoch; for device-timebase Signals this is the
//                          Device Timestamp anchored to the host clock (intervals are exact)
//   f64 values[count]
//   f64 hostTimes[count]   Host Timestamps, only for device-timebase Signals

export const BINARY_SIGNAL_CHUNK = 1;
const HEADER = 8;

export interface SignalChunk {
  handle: number;
  times: Float64Array;
  values: Float64Array;
  hostTimes?: Float64Array;
}

export function encodeSignalChunk(
  handle: number,
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  hostTimes?: ArrayLike<number>,
): Uint8Array {
  const count = times.length;
  const arrays = hostTimes ? 3 : 2;
  const buf = new ArrayBuffer(HEADER + count * 8 * arrays);
  const view = new DataView(buf);
  view.setUint8(0, BINARY_SIGNAL_CHUNK);
  view.setUint8(1, hostTimes ? 1 : 0);
  view.setUint16(2, handle, true);
  view.setUint32(4, count, true);
  new Float64Array(buf, HEADER, count).set(times);
  new Float64Array(buf, HEADER + count * 8, count).set(values);
  if (hostTimes) new Float64Array(buf, HEADER + count * 16, count).set(hostTimes);
  return new Uint8Array(buf);
}

/** Decodes a binary message; returns null if it is not a Signal chunk. */
export function decodeSignalChunk(data: ArrayBuffer): SignalChunk | null {
  if (data.byteLength < HEADER) return null;
  const view = new DataView(data);
  if (view.getUint8(0) !== BINARY_SIGNAL_CHUNK) return null;
  const hasHost = (view.getUint8(1) & 1) !== 0;
  const handle = view.getUint16(2, true);
  const count = view.getUint32(4, true);
  if (data.byteLength !== HEADER + count * 8 * (hasHost ? 3 : 2)) return null;
  return {
    handle,
    times: new Float64Array(data, HEADER, count),
    values: new Float64Array(data, HEADER + count * 8, count),
    ...(hasHost ? { hostTimes: new Float64Array(data, HEADER + count * 16, count) } : {}),
  };
}

export const SerialPortInfo = z.object({
  path: z.string(),
  manufacturer: z.string().optional(),
  serialNumber: z.string().optional(),
  vendorId: z.string().optional(),
  productId: z.string().optional(),
});
export type SerialPortInfo = z.infer<typeof SerialPortInfo>;
