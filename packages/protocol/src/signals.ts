import { z } from "zod";

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
});
export type SignalInfo = z.infer<typeof SignalInfo>;

export const DeviceInfo = z.object({
  id: z.string(),
  frameFormat: z.string(),
  /** Whether the Device can be run as a Virtual Device. */
  virtual: z.boolean(),
  /** Problem loading the Device's Frame Format, if any. */
  error: z.string().optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const SourceKind = z.enum(["virtual"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const SourceState = z.object({
  device: z.string(),
  kind: SourceKind,
  state: z.enum(["running", "stopped"]),
});
export type SourceState = z.infer<typeof SourceState>;

// ---- Binary Signal chunk -----------------------------------------------------
//
// Layout (little-endian), 8-byte aligned so arrays can be viewed without copying:
//   u8  kind = 1
//   u8  reserved
//   u16 handle
//   u32 count
//   f64 times[count]   milliseconds since the Unix epoch
//   f64 values[count]

export const BINARY_SIGNAL_CHUNK = 1;
const HEADER = 8;

export interface SignalChunk {
  handle: number;
  times: Float64Array;
  values: Float64Array;
}

export function encodeSignalChunk(handle: number, times: ArrayLike<number>, values: ArrayLike<number>): Uint8Array {
  const count = times.length;
  const buf = new ArrayBuffer(HEADER + count * 16);
  const view = new DataView(buf);
  view.setUint8(0, BINARY_SIGNAL_CHUNK);
  view.setUint16(2, handle, true);
  view.setUint32(4, count, true);
  new Float64Array(buf, HEADER, count).set(times);
  new Float64Array(buf, HEADER + count * 8, count).set(values);
  return new Uint8Array(buf);
}

/** Decodes a binary message; returns null if it is not a Signal chunk. */
export function decodeSignalChunk(data: ArrayBuffer): SignalChunk | null {
  if (data.byteLength < HEADER) return null;
  const view = new DataView(data);
  if (view.getUint8(0) !== BINARY_SIGNAL_CHUNK) return null;
  const handle = view.getUint16(2, true);
  const count = view.getUint32(4, true);
  if (data.byteLength !== HEADER + count * 16) return null;
  return {
    handle,
    times: new Float64Array(data, HEADER, count),
    values: new Float64Array(data, HEADER + count * 8, count),
  };
}
