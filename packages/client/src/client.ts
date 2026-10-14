import {
  type EventData,
  type EventName,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type ProtocolError,
  PROTOCOL_VERSION,
  ServerMessage,
  type SignalChunk,
  decodeSignalChunk,
} from "@modelviz/protocol";

/**
 * - `connecting`: socket opening or handshake in progress
 * - `connected`: handshake complete, requests may be sent
 * - `disconnected`: no socket; a reconnect may be scheduled
 * - `incompatible`: server speaks a different protocol version; no reconnect
 * - `closed`: closed by the caller; terminal
 */
export type ConnectionState = "connecting" | "connected" | "disconnected" | "incompatible" | "closed";

export class RequestError extends Error {
  readonly code: ProtocolError["code"];
  constructor(error: ProtocolError) {
    super(error.message);
    this.name = "RequestError";
    this.code = error.code;
  }
}

export interface ClientOptions {
  /** Reconnect automatically after the connection drops. Default true. */
  reconnect?: boolean;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Override the protocol version sent in the handshake (tests only). */
  protocolVersion?: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Typed client for the ModelViz Studio server protocol, shared by the web app and tests. */
export class ModelVizClient {
  readonly url: string;
  private readonly opts: Required<ClientOptions>;
  private ws: WebSocket | null = null;
  private _state: ConnectionState = "disconnected";
  private _lastError: ProtocolError | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private readonly eventListeners = new Map<string, Set<(data: unknown) => void>>();
  private readonly chunkListeners = new Set<(chunk: SignalChunk) => void>();
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, options: ClientOptions = {}) {
    this.url = url;
    this.opts = {
      reconnect: options.reconnect ?? true,
      minReconnectDelayMs: options.minReconnectDelayMs ?? 250,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 5000,
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    };
    this.reconnectDelay = this.opts.minReconnectDelayMs;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** The error that put the client in its current state, if any (e.g. a version mismatch). */
  get lastError(): ProtocolError | null {
    return this._lastError;
  }

  connect(): void {
    if (this._state === "closed" || this.ws) return;
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", protocolVersion: this.opts.protocolVersion }));
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.handleText(ev.data);
      else if (ev.data instanceof ArrayBuffer) this.handleBinary(ev.data);
    };
    ws.onclose = () => this.handleClose(ws);
    ws.onerror = () => {
      /* onclose follows and handles it */
    };
  }

  /** Resolves once connected; rejects if the client becomes incompatible or closed first. */
  ready(): Promise<void> {
    if (this._state === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const off = this.onState((s) => {
        if (s === "connected") {
          off();
          resolve();
        } else if (s === "incompatible" || s === "closed") {
          off();
          reject(new Error(this._lastError?.message ?? `connection ${s}`));
        }
      });
    });
  }

  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.setState("closed");
    this.failPending("connection closed");
    ws?.close();
  }

  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const ws = this.ws;
    if (!ws || this._state !== "connected") {
      return Promise.reject(new Error(`not connected (state: ${this._state})`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ type: "request", id, method, params }));
    });
  }

  onState(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  on<E extends EventName>(event: E, listener: (data: EventData<E>) => void): () => void {
    let set = this.eventListeners.get(event);
    if (!set) this.eventListeners.set(event, (set = new Set()));
    const l = listener as (data: unknown) => void;
    set.add(l);
    return () => set.delete(l);
  }

  /** Receives every binary Signal chunk for Signals this client subscribed to. */
  onSignalChunk(listener: (chunk: SignalChunk) => void): () => void {
    this.chunkListeners.add(listener);
    return () => this.chunkListeners.delete(listener);
  }

  private handleBinary(data: ArrayBuffer): void {
    const chunk = decodeSignalChunk(data);
    if (!chunk) return;
    for (const l of this.chunkListeners) l(chunk);
  }

  private handleText(text: string): void {
    let msg: ServerMessage;
    try {
      msg = ServerMessage.parse(JSON.parse(text)) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        this.reconnectDelay = this.opts.minReconnectDelayMs;
        this._lastError = null;
        this.setState("connected");
        break;
      case "fatal":
        this._lastError = msg.error;
        if (msg.error.code === "protocol_version_mismatch") this.setState("incompatible");
        break;
      case "response": {
        const p = this.pending.get(msg.id);
        if (!p) break;
        this.pending.delete(msg.id);
        if ("error" in msg) p.reject(new RequestError(msg.error));
        else p.resolve(msg.result);
        break;
      }
      case "event":
        for (const l of this.eventListeners.get(msg.event) ?? []) l(msg.data);
        break;
    }
  }

  private handleClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.failPending("connection lost");
    if (this._state === "incompatible" || this._state === "closed") return;
    this.setState("disconnected");
    if (!this.opts.reconnect) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.opts.maxReconnectDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private failPending(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  private setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    for (const l of [...this.stateListeners]) l(s);
  }
}
