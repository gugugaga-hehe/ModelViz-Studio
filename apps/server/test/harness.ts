import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientOptions, ModelVizClient } from "@modelviz/client";
import { type RunningServer, type ServerOptions, startServer } from "../src/index.ts";

/**
 * Seam A harness: a real server plus clients that talk to it exactly like the browser does.
 * Use `await using h = await harness()` so everything is torn down after the test.
 */
export async function harness(options: ServerOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-test-"));
  let server: RunningServer = await startServer(options);
  const clients: ModelVizClient[] = [];

  const h = {
    /** Scratch directory for Projects and fixtures; deleted on dispose. */
    dir,
    get server() {
      return server;
    },
    /** A connected client (handshake complete). */
    async client(opts: ClientOptions = {}): Promise<ModelVizClient> {
      const c = h.rawClient(opts);
      c.connect();
      await c.ready();
      return c;
    },
    /** A client that has not connected yet. */
    rawClient(opts: ClientOptions = {}): ModelVizClient {
      const c = new ModelVizClient(server.wsUrl, { minReconnectDelayMs: 20, maxReconnectDelayMs: 100, ...opts });
      clients.push(c);
      return c;
    },
    async restartServer(): Promise<void> {
      const port = Number(new URL(server.url).port);
      await server.close();
      server = await startServer({ ...options, port });
    },
    async [Symbol.asyncDispose]() {
      for (const c of clients) c.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return h;
}

export function waitForState(client: ModelVizClient, state: ModelVizClient["state"]): Promise<void> {
  if (client.state === state) return Promise.resolve();
  return new Promise((resolve) => {
    const off = client.onState((s) => {
      if (s === state) {
        off();
        resolve();
      }
    });
  });
}
