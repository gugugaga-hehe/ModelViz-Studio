import { CHECKSUM_LENGTH, HEADER_LENGTH, INCOMPAT_FLAG_SIGNED, MAVLINK2_STX, SIGNATURE_LENGTH } from "./codec.ts";
import { crcAccumulate, crcBytes } from "./crc.ts";
import type { Dialect, MessageDef } from "./dialect.ts";

export interface ParsedFrame {
  message: MessageDef;
  seq: number;
  sysid: number;
  compid: number;
  /** Full-length payload, zero-padded after truncation. */
  payload: Uint8Array;
}

export interface ParserStats {
  frames: number;
  crcErrors: number;
  unknownMessages: number;
  /** Bytes skipped while searching for a frame start. */
  discardedBytes: number;
}

/**
 * Incremental MAVLink2 frame parser: feed arbitrary byte chunks, get validated frames.
 * Resynchronises on the next start byte after a bad frame.
 */
export class Mavlink2Parser {
  readonly stats: ParserStats = { frames: 0, crcErrors: 0, unknownMessages: 0, discardedBytes: 0 };
  private buf = new Uint8Array(0);

  constructor(private readonly dialect: Dialect) {}

  push(chunk: Uint8Array): ParsedFrame[] {
    const buf = this.buf.length ? concat(this.buf, chunk) : chunk;
    const frames: ParsedFrame[] = [];
    let i = 0;
    while (i < buf.length) {
      if (buf[i] !== MAVLINK2_STX) {
        i++;
        this.stats.discardedBytes++;
        continue;
      }
      if (buf.length - i < HEADER_LENGTH) break;
      const len = buf[i + 1]!;
      const signed = (buf[i + 2]! & INCOMPAT_FLAG_SIGNED) !== 0;
      const total = HEADER_LENGTH + len + CHECKSUM_LENGTH + (signed ? SIGNATURE_LENGTH : 0);
      if (buf.length - i < total) break;

      const msgid = buf[i + 7]! | (buf[i + 8]! << 8) | (buf[i + 9]! << 16);
      const def = this.dialect.byId.get(msgid);
      if (!def) {
        // Without the Message definition we cannot verify the CRC, so the length
        // byte cannot be trusted either: skip only the start byte.
        this.stats.unknownMessages++;
        i++;
        continue;
      }
      const crcAt = i + HEADER_LENGTH + len;
      const crc = crcAccumulate(def.crcExtra, crcBytes(buf, i + 1, crcAt));
      if (crc !== (buf[crcAt]! | (buf[crcAt + 1]! << 8))) {
        this.stats.crcErrors++;
        i++;
        continue;
      }
      const payload = new Uint8Array(Math.max(def.payloadLength, len));
      payload.set(buf.subarray(i + HEADER_LENGTH, crcAt));
      frames.push({ message: def, seq: buf[i + 4]!, sysid: buf[i + 5]!, compid: buf[i + 6]!, payload });
      this.stats.frames++;
      i += total;
    }
    this.buf = buf.slice(i);
    return frames;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
