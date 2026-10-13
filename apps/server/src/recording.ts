import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RecordingInfo } from "@modelviz/protocol";
import { ProtocolFailure } from "./errors.ts";

/**
 * Recording file (ADR-0007): the raw byte stream with Host Timestamps, nothing decoded.
 *
 *   "MVREC 1\n"
 *   <metadata JSON>\n
 *   repeated: f64 hostTime (ms, LE) | u32 length (LE) | <length bytes>
 */
const MAGIC = "MVREC 1\n";
const CHUNK_HEADER = 12;
export const RECORDINGS_DIR = "recordings";
const EXT = ".mvrec";

export interface RecordingMeta {
  device: string;
  frameFormat: string;
  createdAt: number;
  /** Dialect hash the Device reported (and that was verified) when recording started. */
  dialectHash?: string;
}

export function recordingPath(projectPath: string, id: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new ProtocolFailure("invalid_params", `Invalid Recording name: ${id}`);
  return join(projectPath, RECORDINGS_DIR, id + EXT);
}

export class Recorder {
  private readonly stream: WriteStream;
  private bytes = 0;
  private first: number | null = null;
  private last = 0;
  private closed: Promise<void> | null = null;

  private constructor(
    readonly id: string,
    private readonly meta: RecordingMeta,
    path: string,
  ) {
    this.stream = createWriteStream(path, { flags: "wx" });
    this.stream.on("error", () => {});
    this.stream.write(MAGIC + JSON.stringify(meta) + "\n");
  }

  static async create(projectPath: string, id: string, meta: RecordingMeta): Promise<Recorder> {
    await mkdir(join(projectPath, RECORDINGS_DIR), { recursive: true });
    const path = recordingPath(projectPath, id);
    if (await stat(path).then(() => true, () => false)) {
      throw new ProtocolFailure("already_exists", `Recording ${id} already exists`);
    }
    return new Recorder(id, meta, path);
  }

  write(bytes: Uint8Array, hostTime: number): void {
    if (this.closed) return;
    const header = Buffer.allocUnsafe(CHUNK_HEADER);
    header.writeDoubleLE(hostTime, 0);
    header.writeUInt32LE(bytes.length, 8);
    this.stream.write(header);
    this.stream.write(Buffer.from(bytes));
    this.bytes += bytes.length;
    this.first ??= hostTime;
    this.last = hostTime;
  }

  info(): RecordingInfo {
    return {
      id: this.id,
      device: this.meta.device,
      startedAt: this.first ?? this.meta.createdAt,
      durationMs: this.first === null ? 0 : this.last - this.first,
      bytes: this.bytes,
      active: this.closed === null,
    };
  }

  close(): Promise<void> {
    this.closed ??= new Promise((resolve) => this.stream.end(resolve));
    return this.closed;
  }
}

/** Random access to a Recording's chunks; only the chunk index is kept in memory. */
export class RecordingReader {
  private constructor(
    readonly id: string,
    readonly meta: RecordingMeta,
    private readonly path: string,
    /** Host time of each chunk. */
    readonly times: Float64Array,
    private readonly offsets: Float64Array,
    private readonly lengths: Uint32Array,
  ) {}

  static async open(projectPath: string, id: string): Promise<RecordingReader> {
    const path = recordingPath(projectPath, id);
    let fh;
    try {
      fh = await open(path, "r");
    } catch {
      throw new ProtocolFailure("not_found", `Recording ${id} not found`);
    }
    try {
      const size = (await fh.stat()).size;
      const head = Buffer.alloc(Math.min(size, 64 * 1024));
      await fh.read(head, 0, head.length, 0);
      if (head.subarray(0, MAGIC.length).toString() !== MAGIC) throw new ProtocolFailure("invalid_project", `${id} is not a Recording`);
      const nl = head.indexOf(10, MAGIC.length);
      if (nl < 0) throw new ProtocolFailure("invalid_project", `${id}: truncated header`);
      const meta = JSON.parse(head.subarray(MAGIC.length, nl).toString()) as RecordingMeta;

      const times: number[] = [];
      const offsets: number[] = [];
      const lengths: number[] = [];
      const hdr = Buffer.alloc(CHUNK_HEADER);
      let at = nl + 1;
      while (at + CHUNK_HEADER <= size) {
        await fh.read(hdr, 0, CHUNK_HEADER, at);
        const len = hdr.readUInt32LE(8);
        if (at + CHUNK_HEADER + len > size) break; // partial last chunk (e.g. crash while recording)
        times.push(hdr.readDoubleLE(0));
        offsets.push(at + CHUNK_HEADER);
        lengths.push(len);
        at += CHUNK_HEADER + len;
      }
      return new RecordingReader(id, meta, path, Float64Array.from(times), Float64Array.from(offsets), Uint32Array.from(lengths));
    } finally {
      await fh.close();
    }
  }

  get chunkCount(): number {
    return this.times.length;
  }

  get startedAt(): number {
    return this.times[0] ?? this.meta.createdAt;
  }

  get durationMs(): number {
    return this.times.length ? this.times[this.times.length - 1]! - this.times[0]! : 0;
  }

  get totalBytes(): number {
    return this.lengths.reduce((a, b) => a + b, 0);
  }

  info(): RecordingInfo {
    return {
      id: this.id,
      device: this.meta.device,
      startedAt: this.startedAt,
      durationMs: this.durationMs,
      bytes: this.totalBytes,
      active: false,
    };
  }

  /** Index of the first chunk at or after `positionMs` from the start. */
  indexAt(positionMs: number): number {
    const t = this.startedAt + positionMs;
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Reads chunks [from, to) in one sequential read. */
  async read(from: number, to: number): Promise<{ time: number; bytes: Uint8Array }[]> {
    if (from >= to) return [];
    const start = this.offsets[from]!;
    const end = this.offsets[to - 1]! + this.lengths[to - 1]!;
    const buf = Buffer.alloc(end - start);
    const fh = await open(this.path, "r");
    try {
      await fh.read(buf, 0, buf.length, start);
    } finally {
      await fh.close();
    }
    const out: { time: number; bytes: Uint8Array }[] = [];
    for (let i = from; i < to; i++) {
      const o = this.offsets[i]! - start;
      out.push({ time: this.times[i]!, bytes: new Uint8Array(buf.buffer, buf.byteOffset + o, this.lengths[i]!) });
    }
    return out;
  }
}

export async function listRecordings(projectPath: string): Promise<RecordingInfo[]> {
  const dir = join(projectPath, RECORDINGS_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: RecordingInfo[] = [];
  for (const n of names.filter((n) => n.endsWith(EXT)).sort()) {
    try {
      out.push((await RecordingReader.open(projectPath, n.slice(0, -EXT.length))).info());
    } catch {
      /* unreadable file: skip */
    }
  }
  return out;
}
