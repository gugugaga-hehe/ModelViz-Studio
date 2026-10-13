import { crcAccumulate, crcBytes } from "./crc.ts";
import type { FieldDef, MessageDef, ScalarType } from "./dialect.ts";

export const MAVLINK2_STX = 0xfd;
export const HEADER_LENGTH = 10;
export const CHECKSUM_LENGTH = 2;
export const SIGNATURE_LENGTH = 13;
export const INCOMPAT_FLAG_SIGNED = 0x01;

export type FieldValue = number | number[] | string;

function readScalar(view: DataView, type: ScalarType, at: number): number {
  switch (type) {
    case "char":
    case "uint8_t":
      return view.getUint8(at);
    case "int8_t":
      return view.getInt8(at);
    case "uint16_t":
      return view.getUint16(at, true);
    case "int16_t":
      return view.getInt16(at, true);
    case "uint32_t":
      return view.getUint32(at, true);
    case "int32_t":
      return view.getInt32(at, true);
    case "uint64_t":
      return Number(view.getBigUint64(at, true));
    case "int64_t":
      return Number(view.getBigInt64(at, true));
    case "float":
      return view.getFloat32(at, true);
    case "double":
      return view.getFloat64(at, true);
  }
}

function writeScalar(view: DataView, type: ScalarType, at: number, v: number): void {
  switch (type) {
    case "char":
    case "uint8_t":
      return view.setUint8(at, v);
    case "int8_t":
      return view.setInt8(at, v);
    case "uint16_t":
      return view.setUint16(at, v, true);
    case "int16_t":
      return view.setInt16(at, v, true);
    case "uint32_t":
      return view.setUint32(at, v, true);
    case "int32_t":
      return view.setInt32(at, v, true);
    case "uint64_t":
      return view.setBigUint64(at, BigInt(Math.trunc(v)), true);
    case "int64_t":
      return view.setBigInt64(at, BigInt(Math.trunc(v)), true);
    case "float":
      return view.setFloat32(at, v, true);
    case "double":
      return view.setFloat64(at, v, true);
  }
}

const SIZE: Record<ScalarType, number> = {
  char: 1,
  uint8_t: 1,
  int8_t: 1,
  uint16_t: 2,
  int16_t: 2,
  uint32_t: 4,
  int32_t: 4,
  uint64_t: 8,
  int64_t: 8,
  float: 4,
  double: 8,
};

/** Integer types are clamped/rounded so synthetic values always fit the wire type. */
function coerce(type: ScalarType, v: number): number {
  const ranges: Partial<Record<ScalarType, [number, number]>> = {
    char: [0, 255],
    uint8_t: [0, 255],
    int8_t: [-128, 127],
    uint16_t: [0, 65535],
    int16_t: [-32768, 32767],
    uint32_t: [0, 4294967295],
    int32_t: [-2147483648, 2147483647],
    uint64_t: [0, Number.MAX_SAFE_INTEGER],
    int64_t: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  };
  const r = ranges[type];
  if (!r) return v;
  return Math.min(r[1], Math.max(r[0], Math.round(v)));
}

/** Decodes a full-length (zero-padded) payload into Field values. */
export function decodePayload(def: MessageDef, payload: Uint8Array): Record<string, FieldValue> {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const out: Record<string, FieldValue> = {};
  for (const f of def.fields) {
    if (f.arrayLength === 0) {
      out[f.name] = readScalar(view, f.type, f.offset);
    } else if (f.type === "char") {
      const bytes = payload.subarray(f.offset, f.offset + f.arrayLength);
      const end = bytes.indexOf(0);
      out[f.name] = new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
    } else {
      out[f.name] = Array.from({ length: f.arrayLength }, (_, i) => readScalar(view, f.type, f.offset + i * SIZE[f.type]));
    }
  }
  return out;
}

export interface FrameHeader {
  seq: number;
  sysid: number;
  compid: number;
}

/** Encodes one MAVLink2 frame (unsigned), truncating trailing zero bytes of the payload. */
export function encodeFrame(def: MessageDef, values: Record<string, FieldValue>, header: FrameHeader): Uint8Array {
  const payload = new Uint8Array(def.payloadLength);
  const view = new DataView(payload.buffer);
  for (const f of def.fields) writeField(view, payload, f, values[f.name]);
  let len = payload.length;
  while (len > 1 && payload[len - 1] === 0) len--;

  const frame = new Uint8Array(HEADER_LENGTH + len + CHECKSUM_LENGTH);
  frame[0] = MAVLINK2_STX;
  frame[1] = len;
  frame[2] = 0; // incompat flags
  frame[3] = 0; // compat flags
  frame[4] = header.seq & 0xff;
  frame[5] = header.sysid;
  frame[6] = header.compid;
  frame[7] = def.id & 0xff;
  frame[8] = (def.id >> 8) & 0xff;
  frame[9] = (def.id >> 16) & 0xff;
  frame.set(payload.subarray(0, len), HEADER_LENGTH);
  const crc = crcAccumulate(def.crcExtra, crcBytes(frame, 1, HEADER_LENGTH + len));
  frame[HEADER_LENGTH + len] = crc & 0xff;
  frame[HEADER_LENGTH + len + 1] = crc >> 8;
  return frame;
}

function writeField(view: DataView, payload: Uint8Array, f: FieldDef, v: FieldValue | undefined): void {
  if (v === undefined) return;
  if (f.arrayLength === 0) {
    writeScalar(view, f.type, f.offset, coerce(f.type, Number(v)));
  } else if (typeof v === "string") {
    payload.set(new TextEncoder().encode(v).subarray(0, f.arrayLength), f.offset);
  } else {
    const arr = Array.isArray(v) ? v : [v];
    for (let i = 0; i < Math.min(arr.length, f.arrayLength); i++) {
      writeScalar(view, f.type, f.offset + i * SIZE[f.type], coerce(f.type, arr[i]!));
    }
  }
}
