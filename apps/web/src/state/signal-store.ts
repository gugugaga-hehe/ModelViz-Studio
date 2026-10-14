import type { SignalChunk } from "@modelviz/protocol";

/** Seconds of history kept per Signal in the browser. */
export const HISTORY_SECONDS = 30;
/** Capacity per Signal: enough for HISTORY_SECONDS at 8 kHz (ADR-0006). */
const CAPACITY = HISTORY_SECONDS * 8000;

/** Initial capacity per Signal; doubles as samples arrive, up to CAPACITY. */
const INITIAL_CAPACITY = 1024;

/** A Signal's samples in a time window, ready to plot: times in seconds. */
export interface Window {
  xs: number[];
  ys: number[];
}

/**
 * Ring buffer of (time, value) samples for one Signal, kept in time order. It starts small and
 * grows on demand, so slow Signals do not reserve the full CAPACITY.
 */
export class SignalBuffer {
  times = new Float64Array(INITIAL_CAPACITY);
  values = new Float64Array(INITIAL_CAPACITY);
  /** Index of the oldest sample. */
  private head = 0;
  length = 0;
  /** Total samples ever received (monotonic; useful to detect new data). */
  received = 0;

  get capacity(): number {
    return this.times.length;
  }

  push(times: Float64Array, values: Float64Array): void {
    this.reserve(this.length + times.length);
    const cap = this.capacity;
    for (let i = 0; i < times.length; i++) {
      const at = (this.head + this.length) % cap;
      this.times[at] = times[i]!;
      this.values[at] = values[i]!;
      if (this.length < cap) this.length++;
      else this.head = (this.head + 1) % cap;
    }
    this.received += times.length;
  }

  /** Grows the storage (oldest sample first) towards `wanted`, never beyond CAPACITY. */
  private reserve(wanted: number): void {
    let cap = this.capacity;
    if (wanted <= cap || cap >= CAPACITY) return;
    while (cap < wanted && cap < CAPACITY) cap *= 2;
    cap = Math.min(cap, CAPACITY);
    const times = new Float64Array(cap);
    const values = new Float64Array(cap);
    for (let i = 0; i < this.length; i++) {
      const at = (this.head + i) % this.capacity;
      times[i] = this.times[at]!;
      values[i] = this.values[at]!;
    }
    this.times = times;
    this.values = values;
    this.head = 0;
  }

  /** Time of the i-th sample, oldest first. */
  private timeAt(i: number): number {
    return this.times[(this.head + i) % this.capacity]!;
  }

  /** Position (oldest first) of the first sample with time ≥ ms; binary search on the time-ordered samples. */
  indexAt(ms: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timeAt(mid) < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Copies samples with time ≥ fromMs, oldest first; times converted to seconds for plotting. */
  since(fromMs: number): [number[], number[]] {
    const { xs, ys } = this.window(fromMs, Infinity, Infinity);
    return [xs, ys];
  }

  /**
   * Samples in [fromMs, toMs], reduced to at most about 2 × `columns` points: each column of
   * the time range keeps its minimum and maximum (in the order they occurred), so peaks stay
   * visible. Their x positions are the column's first and last sample times, so Signals that
   * share timestamps get identical xs. Windows with few samples are returned as they are.
   */
  window(fromMs: number, toMs: number, columns: number): Window {
    const cap = this.capacity;
    const i0 = this.indexAt(fromMs);
    const i1 = toMs === Infinity ? this.length : this.indexAt(toMs + 1e-9);
    const n = i1 - i0;
    const xs: number[] = [];
    const ys: number[] = [];
    if (n <= 0) return { xs, ys };
    if (n <= 2 * columns) {
      for (let i = i0; i < i1; i++) {
        const at = (this.head + i) % cap;
        xs.push(this.times[at]! / 1000);
        ys.push(this.values[at]!);
      }
      return { xs, ys };
    }
    const t0 = this.timeAt(i0);
    const span = this.timeAt(i1 - 1) - t0 || 1;
    let col = -1;
    let first = 0;
    let lastT = 0;
    let min = 0;
    let max = 0;
    let minAt = 0;
    let maxAt = 0;
    const emit = () => {
      if (col < 0) return;
      if (minAt === maxAt) {
        xs.push(first / 1000);
        ys.push(min);
        return;
      }
      xs.push(first / 1000, lastT / 1000);
      if (minAt < maxAt) ys.push(min, max);
      else ys.push(max, min);
    };
    for (let i = i0; i < i1; i++) {
      const at = (this.head + i) % cap;
      const t = this.times[at]!;
      const v = this.values[at]!;
      const c = Math.min(columns - 1, Math.floor(((t - t0) / span) * columns));
      if (c !== col) {
        emit();
        col = c;
        first = t;
        min = max = v;
        minAt = maxAt = i;
      } else {
        if (v < min) (min = v), (minAt = i);
        if (v > max) (max = v), (maxAt = i);
      }
      lastT = t;
    }
    emit();
    return { xs, ys };
  }

  /** The newest `count` samples (or all there are), oldest first; times in milliseconds. */
  newest(count: number): { times: number[]; values: number[] } {
    const k = Math.min(count, this.length);
    const times = new Array<number>(k);
    const values = new Array<number>(k);
    for (let i = 0; i < k; i++) {
      const at = (this.head + this.length - k + i) % this.capacity;
      times[i] = this.times[at]!;
      values[i] = this.values[at]!;
    }
    return { times, values };
  }

  latestTime(): number | null {
    if (!this.length) return null;
    return this.times[(this.head + this.length - 1) % this.capacity]!;
  }

  latestValue(): number | null {
    if (!this.length) return null;
    return this.values[(this.head + this.length - 1) % this.capacity]!;
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
