import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { type AddressInfo, type Server, type Socket, createServer } from "node:net";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { SourceState } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { deviceSide } from "./device-side.ts";
import { benchProject, collectSamples, harness } from "./harness.ts";

function waitForSource(c: ModelVizClient, state: SourceState["state"], timeoutMs = 8000): Promise<SourceState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for source state ${state}`));
    }, timeoutMs);
    const off = c.on("source.changed", (s) => {
      if (s.state === state) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });
}

/** A TCP "Device" that accepts one connection at a time. */
async function tcpDevice() {
  const sockets: Socket[] = [];
  const connected: ((s: Socket) => void)[] = [];
  const server: Server = createServer((s) => {
    sockets.push(s);
    connected.shift()?.(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    nextConnection: () => new Promise<Socket>((r) => connected.push(r)),
    dropAll: () => sockets.splice(0).forEach((s) => s.destroy()),
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

describe("TCP Transport", () => {
  it("connects, verifies the dialect hash and streams telemetry", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path, byId } = await benchProject(h, c);
    const dev = await deviceSide(path);
    const tcp = await tcpDevice();
    try {
      const sp = byId("bench/BENCH_STATE.setpoint");
      await c.request("signals.subscribe", { ids: [sp.id] });
      const conn = tcp.nextConnection();
      const verifying = waitForSource(c, "verifying");
      await c.request("source.connect", { device: "bench", transport: { kind: "tcp", host: "127.0.0.1", port: tcp.port } });
      const socket = await conn;
      expect(await verifying).toMatchObject({ kind: "tcp", transport: { kind: "tcp", port: tcp.port } });

      // telemetry before the dialect hash is not accepted
      socket.write(dev.benchStates(5, 1000));
      const running = waitForSource(c, "running");
      socket.write(dev.dialectInfo());
      await running;
      socket.write(dev.benchStates(50));
      const s = (await collectSamples(c, [sp.handle], (m) => m.get(sp.handle)!.values.length >= 50)).get(sp.handle)!;
      expect(s.values).toEqual(Array.from({ length: 50 }, (_, i) => i));
    } finally {
      await tcp.close();
    }
  });

  it("refuses to proceed when the dialect hash does not match", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    const dev = await deviceSide(path);
    const tcp = await tcpDevice();
    try {
      const conn = tcp.nextConnection();
      await c.request("source.connect", { device: "bench", transport: { kind: "tcp", host: "127.0.0.1", port: tcp.port } });
      const rejected = waitForSource(c, "rejected");
      (await conn).write(dev.dialectInfo(dev.hash ^ 1));
      const state = await rejected;
      expect(state.error).toMatch(/Dialect hash mismatch/);
      expect(await c.request("sources.list", {})).toEqual([]);
      // the Device can be connected again once fixed
      await expect(
        c.request("source.connect", { device: "bench", transport: { kind: "tcp", host: "127.0.0.1", port: tcp.port } }),
      ).resolves.toMatchObject({ device: "bench" });
    } finally {
      await tcp.close();
    }
  });

  it("reports lost and recovers when the link drops, re-verifying the dialect", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path, byId } = await benchProject(h, c);
    const dev = await deviceSide(path);
    const tcp = await tcpDevice();
    try {
      const sp = byId("bench/BENCH_STATE.setpoint");
      await c.request("signals.subscribe", { ids: [sp.id] });
      let conn = tcp.nextConnection();
      await c.request("source.connect", { device: "bench", transport: { kind: "tcp", host: "127.0.0.1", port: tcp.port } });
      let running = waitForSource(c, "running");
      (await conn).write(dev.dialectInfo());
      await running;

      conn = tcp.nextConnection();
      const lost = waitForSource(c, "lost");
      tcp.dropAll();
      await lost;
      const verifying = waitForSource(c, "verifying");
      const socket = await conn;
      await verifying;
      running = waitForSource(c, "running");
      socket.write(dev.dialectInfo());
      await running;
      socket.write(dev.benchStates(10, 500));
      const s = (await collectSamples(c, [sp.handle], (m) => m.get(sp.handle)!.values.length >= 10)).get(sp.handle)!;
      expect(s.values[0]).toBe(500);
    } finally {
      await tcp.close();
    }
  });

  it("rejects a Device that never reports its dialect hash", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    const tcp = await tcpDevice();
    try {
      await c.request("source.connect", { device: "bench", transport: { kind: "tcp", host: "127.0.0.1", port: tcp.port } });
      const state = await waitForSource(c, "rejected", 8000);
      expect(state.error).toMatch(/No dialect hash/);
    } finally {
      await tcp.close();
    }
  }, 15000);

  it("keeps retrying while nothing is listening", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    const tcp = await tcpDevice();
    const port = tcp.port;
    await tcp.close();
    const state = await c.request("source.connect", { device: "bench", transport: { kind: "tcp", host: "127.0.0.1", port } });
    expect(state.state).toBe("connecting");
    await new Promise((r) => setTimeout(r, 700));
    expect(await c.request("sources.list", {})).toMatchObject([{ device: "bench", state: "connecting" }]);
    await c.request("source.stop", { device: "bench" });
    expect(await c.request("sources.list", {})).toEqual([]);
  });
});

describe("UDP Transport", () => {
  it("receives datagrams from the Device", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path, byId } = await benchProject(h, c);
    const dev = await deviceSide(path);
    const sp = byId("bench/BENCH_STATE.setpoint");
    await c.request("signals.subscribe", { ids: [sp.id] });
    const localPort = 20000 + Math.floor(Math.random() * 20000);
    const running = waitForSource(c, "verifying");
    await c.request("source.connect", { device: "bench", transport: { kind: "udp", localPort } });
    await running;
    const sock = createSocket("udp4");
    const send = (b: Uint8Array) => new Promise<void>((r) => sock.send(b, localPort, "127.0.0.1", () => r()));
    try {
      const ok = waitForSource(c, "running");
      await send(dev.dialectInfo());
      await ok;
      for (let i = 0; i < 5; i++) await send(dev.benchStates(10, i * 10));
      const s = (await collectSamples(c, [sp.handle], (m) => m.get(sp.handle)!.values.length >= 50)).get(sp.handle)!;
      expect(s.values).toEqual(Array.from({ length: 50 }, (_, i) => i));
    } finally {
      sock.close();
    }
  });
});

const hasSocat = spawnSync("which", ["socat"]).status === 0;

/** A pseudo-terminal pair: the server opens `a` as a serial port, the test writes to `b`. */
function ptyPair(dir: string): { a: string; b: string; proc: ChildProcess; ready: Promise<void> } {
  const a = join(dir, "ttyDEV");
  const b = join(dir, "ttyTEST");
  const proc = spawn("socat", [`pty,raw,echo=0,link=${a}`, `pty,raw,echo=0,link=${b}`], { stdio: "ignore" });
  const ready = (async () => {
    for (let i = 0; i < 100 && !(existsSync(a) && existsSync(b)); i++) await new Promise((r) => setTimeout(r, 20));
  })();
  return { a, b, proc, ready };
}

describe.skipIf(!hasSocat)("serial Transport (pseudo-terminal)", () => {
  it("lists serial ports", async () => {
    await using h = await harness();
    const c = await h.client();
    const ports = await c.request("transports.listSerial", {});
    expect(Array.isArray(ports)).toBe(true);
  });

  it("streams from a serial port and recovers after it is unplugged and replugged", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path, byId } = await benchProject(h, c);
    const dev = await deviceSide(path);
    const { open } = await import("node:fs/promises");
    const sp = byId("bench/BENCH_STATE.setpoint");
    await c.request("signals.subscribe", { ids: [sp.id] });

    let pty = ptyPair(h.dir);
    await pty.ready;
    let tty = await open(pty.b, "r+");
    try {
      await c.request("source.connect", { device: "bench", transport: { kind: "serial", path: pty.a, baudRate: 921600 } });
      await waitForSource(c, "verifying");
      let running = waitForSource(c, "running");
      await tty.write(dev.dialectInfo());
      await running;
      await tty.write(dev.benchStates(20));
      await collectSamples(c, [sp.handle], (m) => m.get(sp.handle)!.values.length >= 20);

      // unplug
      const lost = waitForSource(c, "lost");
      await tty.close();
      pty.proc.kill();
      await lost;
      // replug at the same path
      pty = ptyPair(h.dir);
      await pty.ready;
      tty = await open(pty.b, "r+");
      await waitForSource(c, "verifying");
      running = waitForSource(c, "running");
      await tty.write(dev.dialectInfo());
      await running;
      await tty.write(dev.benchStates(10, 900));
      const s = (await collectSamples(c, [sp.handle], (m) => m.get(sp.handle)!.values.includes(909))).get(sp.handle)!;
      expect(s.values.slice(-10)).toEqual(Array.from({ length: 10 }, (_, i) => 900 + i));
    } finally {
      await c.request("source.stop", { device: "bench" });
      await tty.close().catch(() => {});
      pty.proc.kill();
    }
  });
});
