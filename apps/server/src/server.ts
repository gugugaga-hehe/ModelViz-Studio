import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { ClientMessage, type MethodName, PROTOCOL_PATH, PROTOCOL_VERSION, type ServerMessage } from "@modelviz/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { ProtocolFailure } from "./errors.ts";
import { createStaticHandler } from "./static.ts";
import { Workbench } from "./workbench.ts";

export const SERVER_VERSION = "0.0.0";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface ServerOptions {
  /** Interface to bind. Must be loopback (ADR-0001: single-user, local only). */
  host?: string;
  /** TCP port; 0 picks a free one. */
  port?: number;
  /** Directory of the built web app to serve over HTTP. */
  staticDir?: string;
  /** Extra browser origins allowed to open the WebSocket (e.g. the dev server). */
  allowedOrigins?: string[];
}

export interface RunningServer {
  /** Base HTTP URL, e.g. http://127.0.0.1:5174 */
  url: string;
  /** WebSocket URL for the client protocol. */
  wsUrl: string;
  close(): Promise<void>;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function send(ws: WebSocket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function handleConnection(ws: WebSocket, bench: Workbench): void {
  let greeted = false;
  ws.on("message", async (raw, isBinary) => {
    if (isBinary) return;
    let msg: ClientMessage;
    try {
      msg = ClientMessage.parse(JSON.parse(raw.toString()));
    } catch {
      send(ws, { type: "fatal", error: { code: "bad_message", message: "Malformed message" } });
      ws.close();
      return;
    }
    if (msg.type === "hello") {
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        send(ws, {
          type: "fatal",
          error: {
            code: "protocol_version_mismatch",
            message: `Server speaks protocol v${PROTOCOL_VERSION}, client sent v${msg.protocolVersion}`,
          },
        });
        ws.close();
        return;
      }
      greeted = true;
      bench.clients.add(ws);
      send(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION, serverVersion: SERVER_VERSION });
      return;
    }
    if (!greeted) {
      send(ws, { type: "fatal", error: { code: "bad_message", message: "Handshake required" } });
      ws.close();
      return;
    }
    const handler = bench.handlers[msg.method as MethodName];
    if (!handler) {
      send(ws, { type: "response", id: msg.id, error: { code: "unknown_method", message: msg.method } });
      return;
    }
    try {
      send(ws, { type: "response", id: msg.id, result: await handler(msg.params, { ws }) });
    } catch (e) {
      const error =
        e instanceof ProtocolFailure
          ? { code: e.code, message: e.message }
          : e instanceof Error && e.name === "ZodError"
            ? { code: "invalid_params" as const, message: e.message }
            : { code: "internal" as const, message: e instanceof Error ? e.message : String(e) };
      send(ws, { type: "response", id: msg.id, error });
    }
  });
  ws.on("close", () => bench.removeClient(ws));
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Refusing to bind to non-loopback interface "${host}"`);
  }
  const bench = new Workbench();
  const serveStatic = options.staticDir ? createStaticHandler(options.staticDir) : null;
  const http = createServer((req, res) => {
    if (serveStatic) serveStatic(req, res).catch(() => res.writeHead(500).end());
    else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  const reject = (socket: Duplex, status: string) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  };

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== PROTOCOL_PATH) return reject(socket, "404 Not Found");
    if (!isLoopbackAddress(req.socket.remoteAddress)) return reject(socket, "403 Forbidden");
    // Any web page the user visits could try to reach a localhost WebSocket;
    // only our own UI (and explicitly allowed dev origins) may connect.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin) && origin !== ownOrigin(req)) {
      return reject(socket, "403 Forbidden");
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, bench));
  });

  await new Promise<void>((resolve, rejectListen) => {
    http.once("error", rejectListen);
    http.listen(options.port ?? 0, host, () => resolve());
  });
  const { port } = http.address() as AddressInfo;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const url = `http://${urlHost}:${port}`;

  return {
    url,
    wsUrl: `ws://${urlHost}:${port}${PROTOCOL_PATH}`,
    close: () =>
      new Promise<void>((resolve) => {
        bench.close();
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}

function ownOrigin(req: IncomingMessage): string | undefined {
  return req.headers.host ? `http://${req.headers.host}` : undefined;
}
