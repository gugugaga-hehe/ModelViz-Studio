import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { type Socket, connect } from "node:net";
import type { SerialPortInfo, TransportConfig } from "@modelviz/protocol";
import { SerialPort } from "serialport";

/** Delay between reconnection attempts after the link drops (ms). */
const RETRY_MS = 500;

export type TransportStatus = "connecting" | "connected" | "lost";

export interface TransportEvents {
  onData(bytes: Uint8Array): void;
  onStatus(status: TransportStatus, error?: string): void;
}

/** A byte-stream carrier. Knows nothing about Framing (ADR-0002). */
export interface Transport {
  start(): void;
  stop(): void;
  write(bytes: Uint8Array): void;
}

export function createTransport(config: TransportConfig, events: TransportEvents): Transport {
  switch (config.kind) {
    case "serial":
      return new Reconnecting(events, (ev) => openSerial(config.path, config.baudRate, ev));
    case "tcp":
      return new Reconnecting(events, (ev) => openTcp(config.host, config.port, ev));
    case "udp":
      return new UdpTransport(config, events);
  }
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const ports = await SerialPort.list();
  // USB adapters and CDC devices first; legacy on-board ttyS* ports last.
  const rank = (p: string) => (/ttyACM|ttyUSB|usbmodem|usbserial|COM\d/.test(p) ? 0 : 1);
  return ports
    .sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path, undefined, { numeric: true }))
    .map((p) => ({
      path: p.path,
      ...(p.manufacturer ? { manufacturer: p.manufacturer } : {}),
      ...(p.serialNumber ? { serialNumber: p.serialNumber } : {}),
      ...(p.vendorId ? { vendorId: p.vendorId } : {}),
      ...(p.productId ? { productId: p.productId } : {}),
    }));
}

interface Connection {
  write(bytes: Uint8Array): void;
  close(): void;
}

interface ConnectionEvents {
  onOpen(): void;
  onData(bytes: Uint8Array): void;
  /** Called once when the connection fails to open or drops. */
  onClose(error?: string): void;
}

/** Keeps a stream connection open, retrying until stopped (e.g. a cable being replugged). */
class Reconnecting implements Transport {
  private conn: Connection | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private everConnected = false;

  constructor(
    private readonly events: TransportEvents,
    private readonly open: (ev: ConnectionEvents) => Connection,
  ) {}

  start(): void {
    this.stopped = false;
    this.events.onStatus("connecting");
    this.attempt();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.conn?.close();
    this.conn = null;
  }

  write(bytes: Uint8Array): void {
    this.conn?.write(bytes);
  }

  private attempt(): void {
    if (this.stopped) return;
    let closed = false;
    this.conn = this.open({
      onOpen: () => {
        this.everConnected = true;
        this.events.onStatus("connected");
      },
      onData: (b) => this.events.onData(b),
      onClose: (error) => {
        if (closed) return;
        closed = true;
        this.conn = null;
        if (this.stopped) return;
        this.events.onStatus(this.everConnected ? "lost" : "connecting", error);
        this.retry = setTimeout(() => {
          this.retry = null;
          this.attempt();
        }, RETRY_MS);
      },
    });
  }
}

function openSerial(path: string, baudRate: number, ev: ConnectionEvents): Connection {
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  port.on("data", (b: Buffer) => ev.onData(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
  port.on("close", () => ev.onClose());
  port.on("error", (e) => {
    ev.onClose(e.message);
    if (port.isOpen) port.close(() => {});
  });
  port.open((err) => {
    if (err) ev.onClose(err.message);
    else ev.onOpen();
  });
  return {
    write: (b) => void port.write(Buffer.from(b)),
    close: () => {
      port.removeAllListeners();
      port.on("error", () => {});
      if (port.isOpen) port.close(() => {});
    },
  };
}

function openTcp(host: string, port: number, ev: ConnectionEvents): Connection {
  const socket: Socket = connect({ host, port });
  socket.setNoDelay(true);
  socket.on("connect", () => ev.onOpen());
  socket.on("data", (b) => ev.onData(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
  socket.on("error", (e) => ev.onClose(e.message));
  socket.on("close", () => ev.onClose());
  return {
    write: (b) => void socket.write(b),
    close: () => {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
    },
  };
}

/** UDP is connectionless: "connected" once bound; replies go to the configured or last-seen peer. */
class UdpTransport implements Transport {
  private socket: UdpSocket | null = null;
  private peer: { host: string; port: number } | null;

  constructor(
    private readonly config: Extract<TransportConfig, { kind: "udp" }>,
    private readonly events: TransportEvents,
  ) {
    this.peer = config.remoteHost && config.remotePort ? { host: config.remoteHost, port: config.remotePort } : null;
  }

  start(): void {
    this.events.onStatus("connecting");
    const socket = createSocket("udp4");
    this.socket = socket;
    socket.on("message", (msg, rinfo) => {
      if (!this.config.remoteHost) this.peer = { host: rinfo.address, port: rinfo.port };
      this.events.onData(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
    });
    socket.on("error", (e) => this.events.onStatus("lost", e.message));
    socket.bind(this.config.localPort, () => this.events.onStatus("connected"));
  }

  stop(): void {
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
  }

  write(bytes: Uint8Array): void {
    if (this.socket && this.peer) this.socket.send(bytes, this.peer.port, this.peer.host);
  }
}
