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

/** Collects samples of the given Signal handles until `until` returns true or the timeout hits. */
export interface Collected {
  times: number[];
  values: number[];
  /** Host Timestamps, present only for device-timebase Signals. */
  hostTimes: number[];
}

export function collectSamples(
  client: ModelVizClient,
  handles: number[],
  until: (samples: Map<number, Collected>) => boolean,
  timeoutMs = 5000,
): Promise<Map<number, Collected>> {
  const samples = new Map<number, Collected>(handles.map((h) => [h, { times: [], values: [], hostTimes: [] }]));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out collecting samples: ${[...samples].map(([h, s]) => `${h}=${s.values.length}`).join(" ")}`));
    }, timeoutMs);
    const off = client.onSignalChunk((chunk) => {
      const s = samples.get(chunk.handle);
      if (!s) return;
      s.times.push(...chunk.times);
      s.values.push(...chunk.values);
      if (chunk.hostTimes) s.hostTimes.push(...chunk.hostTimes);
      if (until(samples)) {
        clearTimeout(timer);
        off();
        resolve(samples);
      }
    });
  });
}

export async function benchProject(h: Awaited<ReturnType<typeof harness>>, client: ModelVizClient, name = "bench") {
  const path = (await import("node:path")).join(h.dir, name);
  await client.request("project.create", { path, name, template: "virtual-bench" });
  const signals = await client.request("signals.list", {});
  const byId = (id: string) => {
    const s = signals.find((x) => x.id === id);
    if (!s) throw new Error(`no Signal ${id}`);
    return s;
  };
  return { path, signals, byId };
}

/** Edits a YAML file in a Project in place. */
export async function editYaml(path: string, edit: (doc: any) => void): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { parse, stringify } = await import("yaml");
  const doc = parse(await readFile(path, "utf8"));
  edit(doc);
  await writeFile(path, stringify(doc));
}
