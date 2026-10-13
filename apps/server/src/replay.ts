import type { ReplayState } from "@modelviz/protocol";

/** Anything with time-ordered items that can be read in index ranges (Recordings, CSV imports). */
export interface TimedSource<T extends { time: number }> {
  readonly id: string;
  /** Time of the first item (ms). */
  readonly startedAt: number;
  readonly durationMs: number;
  readonly chunkCount: number;
  indexAt(positionMs: number): number;
  read(from: number, to: number): Promise<T[]>;
}

/** How often the player wakes up to emit due chunks (ms). */
const TICK_MS = 5;
/** Chunks read from disk per batch. */
const READ_BATCH = 256;

/**
 * Plays time-ordered items back with their original timing (scaled by speed).
 * Each item is emitted with its original time, so replayed Signals keep their times.
 */
export class ReplayPlayer<T extends { time: number }> {
  private next = 0;
  private playing = false;
  private speed: number;
  /** Replay position (ms from start) at wall time `baseWall`. */
  private basePos = 0;
  private baseWall = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private queue: T[] = [];
  /** Bumped on seek so an in-flight disk read cannot refill the queue with stale chunks. */
  private epoch = 0;

  constructor(
    private readonly reader: TimedSource<T>,
    private readonly emit: (item: T) => void,
    private readonly onChange: () => void,
    speed: number,
  ) {
    this.speed = speed;
  }

  state(): ReplayState {
    return {
      recording: this.reader.id,
      playing: this.playing,
      positionMs: this.position(),
      durationMs: this.reader.durationMs,
      speed: this.speed,
    };
  }

  play(): void {
    if (this.playing) return;
    if (this.next >= this.reader.chunkCount) this.seek(0);
    this.basePos = this.position();
    this.baseWall = performance.now();
    this.playing = true;
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
    this.onChange();
  }

  pause(): void {
    if (!this.playing) return;
    this.basePos = this.position();
    this.playing = false;
    this.onChange();
  }

  /** Jumps to a position; the caller resets downstream decoding state. */
  seek(positionMs: number): void {
    const pos = Math.max(0, Math.min(positionMs, this.reader.durationMs));
    this.next = this.reader.indexAt(pos);
    this.queue = [];
    this.epoch++;
    this.basePos = pos;
    this.baseWall = performance.now();
    this.onChange();
  }

  setSpeed(speed: number): void {
    this.basePos = this.position();
    this.baseWall = performance.now();
    this.speed = speed;
    this.onChange();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
  }

  private position(): number {
    if (!this.playing) return this.basePos;
    return Math.min(this.reader.durationMs, this.basePos + (performance.now() - this.baseWall) * this.speed);
  }

  private async tick(): Promise<void> {
    if (!this.playing || this.busy) return;
    this.busy = true;
    try {
      const due = this.reader.startedAt + this.position();
      while (this.playing) {
        if (!this.queue.length) {
          if (this.next >= this.reader.chunkCount) break;
          const to = Math.min(this.reader.chunkCount, this.next + READ_BATCH);
          const from = this.next;
          this.next = to;
          const epoch = this.epoch;
          const chunks = await this.reader.read(from, to);
          if (epoch !== this.epoch) return;
          this.queue = chunks;
        }
        const head = this.queue[0]!;
        if (head.time > due) break;
        this.queue.shift();
        this.emit(head);
      }
      if (this.playing && this.next >= this.reader.chunkCount && !this.queue.length) {
        this.basePos = this.reader.durationMs;
        this.playing = false;
        this.onChange();
      }
    } finally {
      this.busy = false;
    }
  }
}
