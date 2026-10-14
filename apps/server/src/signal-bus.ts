import { type EventData, type SignalInfo, encodeSignalChunk } from "@modelviz/protocol";
import type { WebSocket } from "ws";

/** How often pending samples are flushed to subscribers (ms). */
const FLUSH_INTERVAL_MS = 33;
/** A client with more than this queued for sending skips chunks until it catches up (bytes). */
export const MAX_BUFFERED_BYTES = 1 << 20;

interface Pending {
  times: number[];
  values: number[];
  hostTimes: number[];
}

/**
 * Collects samples per Signal and forwards them to subscribed clients as binary chunks
 * at a fixed rate, decoupling client traffic from the Device's frame rate.
 */
export class SignalBus {
  private readonly handles = new Map<string, number>();
  private nextHandle = 1;
  private signals: SignalInfo[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly subscribers = new Map<WebSocket, Set<number>>();
  /** Server-side listeners (e.g. live Systems) per handle. */
  private readonly taps = new Map<number, Set<(time: number, value: number) => void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  /** Samples skipped per client and Signal handle since the client was last told. */
  private readonly dropped = new Map<WebSocket, Map<number, number>>();

  /** `onDropped` tells one client which samples it missed, once it reads again. */
  constructor(private readonly onDropped: (ws: WebSocket, data: EventData<"signals.dropped">) => void = () => {}) {
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Stable numeric handle for a Signal id, allocated on first use. */
  handleOf(id: string): number {
    let h = this.handles.get(id);
    if (h === undefined) {
      h = this.nextHandle++;
      this.handles.set(id, h);
    }
    return h;
  }

  setSignals(signals: SignalInfo[]): void {
    this.signals = signals;
  }

  list(): SignalInfo[] {
    return this.signals;
  }

  subscribe(ws: WebSocket, ids: string[]): void {
    const known = new Set(this.signals.map((s) => s.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown Signal(s): ${unknown.join(", ")}`);
    let set = this.subscribers.get(ws);
    if (!set) this.subscribers.set(ws, (set = new Set()));
    for (const id of ids) set.add(this.handleOf(id));
  }

  unsubscribe(ws: WebSocket, ids: string[]): void {
    const set = this.subscribers.get(ws);
    if (!set) return;
    for (const id of ids) {
      const h = this.handles.get(id);
      if (h !== undefined) set.delete(h);
    }
  }

  removeClient(ws: WebSocket): void {
    this.subscribers.delete(ws);
    this.dropped.delete(ws);
  }

  /** Calls `fn` for every sample of a Signal published from now on. */
  tap(handle: number, fn: (time: number, value: number) => void): () => void {
    let set = this.taps.get(handle);
    if (!set) this.taps.set(handle, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Appends a sample for one Signal; dropped immediately if nobody is subscribed. */
  publish(handle: number, time: number, value: number, hostTime: number | null = null): void {
    const taps = this.taps.get(handle);
    if (taps) for (const fn of taps) fn(time, value);
    if (!this.hasSubscriber(handle)) return;
    let p = this.pending.get(handle);
    if (!p) this.pending.set(handle, (p = { times: [], values: [], hostTimes: [] }));
    p.times.push(time);
    p.values.push(value);
    if (hostTime !== null) p.hostTimes.push(hostTime);
  }

  private hasSubscriber(handle: number): boolean {
    for (const set of this.subscribers.values()) if (set.has(handle)) return true;
    return false;
  }

  flush(): void {
    for (const [handle, p] of this.pending) {
      if (!p.times.length) continue;
      const host = p.hostTimes.length === p.times.length ? p.hostTimes : undefined;
      const chunk = encodeSignalChunk(handle, p.times, p.values, host);
      for (const [ws, set] of this.subscribers) {
        if (!set.has(handle) || ws.readyState !== ws.OPEN) continue;
        // a client that is not reading (paused tab, debugger, long GC) must not grow server memory
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          let counts = this.dropped.get(ws);
          if (!counts) this.dropped.set(ws, (counts = new Map()));
          counts.set(handle, (counts.get(handle) ?? 0) + p.times.length);
          continue;
        }
        ws.send(chunk);
      }
    }
    this.pending.clear();
    this.reportDrops();
  }

  /** Tells clients that caught up again what they missed. */
  private reportDrops(): void {
    if (!this.dropped.size) return;
    const ids = new Map([...this.handles].map(([id, h]) => [h, id]));
    for (const [ws, counts] of this.dropped) {
      if (ws.readyState !== ws.OPEN) {
        this.dropped.delete(ws);
        continue;
      }
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      this.dropped.delete(ws);
      this.onDropped(ws, { signals: [...counts].map(([h, samples]) => ({ id: ids.get(h) ?? String(h), samples })) });
    }
  }

  close(): void {
    clearInterval(this.timer);
  }
}
