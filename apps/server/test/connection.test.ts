import { PROTOCOL_PATH, PROTOCOL_VERSION } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { startServer } from "../src/index.ts";
import { harness, waitForState } from "./harness.ts";

describe("connection and handshake", () => {
  it("completes a versioned handshake", async () => {
    await using h = await harness();
    const c = await h.client();
    expect(c.state).toBe("connected");
  });

  it("reports a protocol version mismatch and does not reconnect", async () => {
    await using h = await harness();
    const c = h.rawClient({ protocolVersion: PROTOCOL_VERSION + 1 });
    c.connect();
    await expect(c.ready()).rejects.toThrow(/protocol v/);
    expect(c.state).toBe("incompatible");
    expect(c.lastError?.code).toBe("protocol_version_mismatch");
  });

  it("reconnects automatically after the server restarts", async () => {
    await using h = await harness();
    const c = await h.client();
    const dropped = waitForState(c, "disconnected");
    await h.restartServer();
    await dropped;
    await waitForState(c, "connected");
    expect(await c.request("project.current", {})).toBeNull();
  });

  it("rejects requests sent before the handshake", async () => {
    await using h = await harness();
    const ws = new WebSocket(h.server.wsUrl);
    const msg = await new Promise<string>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: "request", id: 1, method: "project.current", params: {} }));
      ws.onmessage = (e) => resolve(String(e.data));
    });
    expect(JSON.parse(msg)).toMatchObject({ type: "fatal", error: { code: "bad_message" } });
  });

  it("answers unknown methods with an error", async () => {
    await using h = await harness();
    const c = await h.client();
    // @ts-expect-error deliberately unknown method
    await expect(c.request("no.such.method", {})).rejects.toMatchObject({ code: "unknown_method" });
  });
});

describe("local-only access (ADR-0001)", () => {
  it("refuses to bind to a non-loopback interface", async () => {
    await expect(startServer({ host: "0.0.0.0" })).rejects.toThrow(/non-loopback/);
  });

  it("binds to loopback by default", async () => {
    await using h = await harness();
    expect(new URL(h.server.url).hostname).toBe("127.0.0.1");
  });

  it("rejects WebSocket connections from foreign browser origins", async () => {
    await using h = await harness();
    const status = await upgradeStatus(h.server.url, "https://evil.example");
    expect(status).toBe(403);
  });

  it("accepts its own origin and explicitly allowed origins", async () => {
    await using h = await harness({ allowedOrigins: ["http://localhost:5173"] });
    expect(await upgradeStatus(h.server.url, h.server.url)).toBe(101);
    expect(await upgradeStatus(h.server.url, "http://localhost:5173")).toBe(101);
  });
});

/** Performs a raw WebSocket upgrade with a chosen Origin header and returns the HTTP status. */
async function upgradeStatus(baseUrl: string, origin: string): Promise<number> {
  const { request } = await import("node:http");
  const url = new URL(PROTOCOL_PATH, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        Origin: origin,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", (e) => (String(e).includes("socket hang up") ? resolve(403) : reject(e)));
    req.end();
  });
}
