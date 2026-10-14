import { type SignalInfo, encodeSignalChunk } from "@modelviz/protocol";
import type { WebSocket } from "ws";

/** How often pending samples are flushed to subscribers (ms). */
const FLUSH_INTERVAL_MS = 33;

interface Pending {
  times: number[];
  values: number[];
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
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
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
  }

  /** Appends samples for one Signal; dropped immediately if nobody is subscribed. */
  publish(handle: number, time: number, value: number): void {
    if (!this.hasSubscriber(handle)) return;
    let p = this.pending.get(handle);
    if (!p) this.pending.set(handle, (p = { times: [], values: [] }));
    p.times.push(time);
    p.values.push(value);
  }

  private hasSubscriber(handle: number): boolean {
    for (const set of this.subscribers.values()) if (set.has(handle)) return true;
    return false;
  }

  flush(): void {
    for (const [handle, p] of this.pending) {
      if (!p.times.length) continue;
      const chunk = encodeSignalChunk(handle, p.times, p.values);
      for (const [ws, set] of this.subscribers) if (set.has(handle) && ws.readyState === ws.OPEN) ws.send(chunk);
    }
    this.pending.clear();
  }

  close(): void {
    clearInterval(this.timer);
  }
}
