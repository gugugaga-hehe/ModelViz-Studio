import type { SignalChunk } from "@modelviz/protocol";

/** Seconds of history kept per Signal in the browser. */
export const HISTORY_SECONDS = 30;
/** Capacity per Signal: enough for HISTORY_SECONDS at 8 kHz (ADR-0006). */
const CAPACITY = HISTORY_SECONDS * 8000;

/** Fixed-capacity ring buffer of (time, value) samples for one Signal. */
export class SignalBuffer {
  readonly times = new Float64Array(CAPACITY);
  readonly values = new Float64Array(CAPACITY);
  /** Index of the oldest sample. */
  private head = 0;
  length = 0;
  /** Total samples ever received (monotonic; useful to detect new data). */
  received = 0;

  push(times: Float64Array, values: Float64Array): void {
    for (let i = 0; i < times.length; i++) {
      const at = (this.head + this.length) % CAPACITY;
      this.times[at] = times[i]!;
      this.values[at] = values[i]!;
      if (this.length < CAPACITY) this.length++;
      else this.head = (this.head + 1) % CAPACITY;
    }
    this.received += times.length;
  }

  /** Copies samples with time ≥ fromMs, oldest first; times converted to seconds for plotting. */
  since(fromMs: number): [number[], number[]] {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < this.length; i++) {
      const at = (this.head + i) % CAPACITY;
      const t = this.times[at]!;
      if (t < fromMs) continue;
      xs.push(t / 1000);
      ys.push(this.values[at]!);
    }
    return [xs, ys];
  }

  latestTime(): number | null {
    if (!this.length) return null;
    return this.times[(this.head + this.length - 1) % CAPACITY]!;
  }

  latestValue(): number | null {
    if (!this.length) return null;
    return this.values[(this.head + this.length - 1) % CAPACITY]!;
  }

  clear(): void {
    this.head = 0;
    this.length = 0;
  }
}

/** Buffers by Signal handle. Lives outside React: high-rate data never goes through React state. */
export class SignalStore {
  private readonly buffers = new Map<number, SignalBuffer>();

  buffer(handle: number): SignalBuffer {
    let b = this.buffers.get(handle);
    if (!b) this.buffers.set(handle, (b = new SignalBuffer()));
    return b;
  }

  ingest(chunk: SignalChunk): void {
    this.buffer(chunk.handle).push(chunk.times, chunk.values);
  }

  clear(): void {
    this.buffers.clear();
  }
}
