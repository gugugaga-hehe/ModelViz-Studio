import { type AddressInfo, type Socket, createServer } from "node:net";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { EventData } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { loadDialect } from "../src/mavlink/dialect.ts";
import { Mavlink2Parser } from "../src/mavlink/parser.ts";
import { decodePayload } from "../src/mavlink/codec.ts";
import { deviceSide } from "./device-side.ts";
import { benchProject, editYaml, harness } from "./harness.ts";

type H = Awaited<ReturnType<typeof harness>>;

async function untilRunning(c: ModelVizClient, device = "bench"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = (await c.request("sources.list", {})).find((x) => x.device === device);
    if (s?.state === "running") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${device} did not reach running`);
}

/** The example bench Project, running as a Virtual Device. */
async function runningBench(h: H, edit?: (doc: any) => void) {
  const c = await h.client();
  const { path } = await benchProject(h, c);
  if (edit) {
    await editYaml(join(path, "project.yaml"), edit);
    await c.request("project.open", { path });
  }
  await c.request("source.startVirtual", { device: "bench" });
  await untilRunning(c);
  return { c, path };
}

describe("Device Parameters on the Virtual Device", () => {
  it("enumerates the Device Parameters in the Device's order, without turning them into Signals", async () => {
    await using h = await harness();
    const { c } = await runningBench(h);
    const list = await c.request("parameters.list", { device: "bench" });
    expect(list).toMatchObject({ device: "bench", count: 5, missing: [] });
    expect(list.parameters.map((p) => [p.index, p.name, p.type])).toEqual([
      [0, "RATE_KP", "float"],
      [1, "RATE_KI", "float"],
      [2, "GYRO_LPF_HZ", "float"],
      [3, "CTRL_MODE", "uint8"],
      [4, "FW_VERSION", "int32"],
    ]);
    expect(list.parameters[0]!.value).toBeCloseTo(0.8, 6);
    expect(list.parameters[4]!.value).toBe(10203);
    const signals = await c.request("signals.list", {});
    expect(signals.some((s) => s.message.startsWith("PARAM_"))).toBe(false);
  });

  it("reads and writes a single Device Parameter with acknowledgement", async () => {
    await using h = await harness();
    const { c } = await runningBench(h);
    expect(await c.request("parameters.read", { device: "bench", name: "RATE_KI" })).toEqual({ name: "RATE_KI", value: 40, type: "float", index: 1 });

    const changed: EventData<"parameters.changed">[] = [];
    c.on("parameters.changed", (e) => changed.push(e));
    const w = await c.request("parameters.write", { device: "bench", name: "RATE_KI", value: 55.5 });
    expect(w).toEqual({ device: "bench", requested: 55.5, accepted: true, parameter: { name: "RATE_KI", value: 55.5, type: "float", index: 1 } });
    expect(changed).toContainEqual({ device: "bench", parameter: w.parameter });
    expect((await c.request("parameters.read", { device: "bench", name: "RATE_KI" })).value).toBe(55.5);

    // float Device Parameters hold single precision: the acknowledged value is the stored one
    const kp = await c.request("parameters.write", { device: "bench", name: "RATE_KP", value: 0.1 });
    expect(kp.accepted).toBe(true);
    expect(kp.parameter.value).toBe(Math.fround(0.1));
    // integer Device Parameters
    expect(await c.request("parameters.write", { device: "bench", name: "CTRL_MODE", value: 3 })).toMatchObject({
      accepted: true,
      parameter: { value: 3, type: "uint8" },
    });
  });

  it("reports refused writes with the value the Device kept", async () => {
    await using h = await harness();
    const { c } = await runningBench(h);
    // outside the Device's range
    expect(await c.request("parameters.write", { device: "bench", name: "RATE_KP", value: 9 })).toMatchObject({
      requested: 9,
      accepted: false,
      parameter: { name: "RATE_KP", value: Math.fround(0.8) },
    });
    // read-only
    expect(await c.request("parameters.write", { device: "bench", name: "FW_VERSION", value: 1 })).toMatchObject({
      accepted: false,
      parameter: { value: 10203 },
    });
    // not representable in the Device Parameter's type: never sent
    await expect(c.request("parameters.write", { device: "bench", name: "CTRL_MODE", value: 1.5 })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(c.request("parameters.write", { device: "bench", name: "CTRL_MODE", value: 300 })).rejects.toMatchObject({ code: "invalid_params" });
    expect((await c.request("parameters.read", { device: "bench", name: "CTRL_MODE" })).value).toBe(1);
  });

  it("fails clearly when the Device does not answer", async () => {
    await using h = await harness();
    const { c } = await runningBench(h);
    await expect(c.request("parameters.read", { device: "bench", name: "NO_SUCH" })).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringMatching(/No answer from the Device reading NO_SUCH/),
    });
    await expect(c.request("parameters.write", { device: "bench", name: "NO_SUCH", value: 1 })).rejects.toMatchObject({ code: "timeout" });
    await expect(c.request("parameters.read", { device: "bench", name: "A_NAME_LONGER_THAN_16" })).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("completes the enumeration when frames are lost on the link", async () => {
    await using h = await harness();
    const { c } = await runningBench(h, (doc) => {
      doc.devices[0].virtual.faults = { dropEvery: 3 };
      // only the dialect check and the parameter traffic, so the drops hit parameter answers
      doc.devices[0].virtual.messages = { DIALECT_INFO: { rateHz: 20 } };
    });
    const list = await c.request("parameters.list", { device: "bench" });
    expect(list.missing).toEqual([]);
    expect(list.parameters.map((p) => p.name)).toEqual(["RATE_KP", "RATE_KI", "GYRO_LPF_HZ", "CTRL_MODE", "FW_VERSION"]);
  });

  it("reports a Device without Device Parameters", async () => {
    await using h = await harness();
    const { c } = await runningBench(h, (doc) => {
      doc.devices[0].virtual.parameters = {};
    });
    await expect(c.request("parameters.list", { device: "bench" })).rejects.toMatchObject({ code: "timeout" });
  });

  it("needs a running Source that can reach the Device", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    await expect(c.request("parameters.list", { device: "bench" })).rejects.toMatchObject({ code: "conflict" });
    await c.request("source.startVirtual", { device: "bench" });
    await untilRunning(c);
    await c.request("recording.start", { device: "bench", name: "r" });
    await new Promise((r) => setTimeout(r, 300));
    await c.request("recording.stop", { device: "bench" });
    await c.request("source.stop", { device: "bench" });
    await expect(c.request("parameters.read", { device: "bench", name: "RATE_KP" })).rejects.toMatchObject({ code: "conflict" });
    await c.request("source.startReplay", { device: "bench", recording: "r" });
    await expect(c.request("parameters.read", { device: "bench", name: "RATE_KP" })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/live or Virtual Device/),
    });
  });
});

describe("Device Parameters over a real Transport", () => {
  it("sends standard parameter requests to the Device's address and takes its answer", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    const dev = await deviceSide(path);
    const dialect = await loadDialect(join(path, "dialects/bench.xml"));
    const parser = new Mavlink2Parser(dialect);
    const received: { message: string; sysid: number; compid: number; values: Record<string, unknown> }[] = [];
    const conn: { socket?: Socket } = {};
    const server = createServer((s) => {
      conn.socket = s;
      s.on("data", (b) => {
        for (const f of parser.push(new Uint8Array(b))) {
          const values = decodePayload(f.message, f.payload);
          received.push({ message: f.message.name, sysid: f.sysid, compid: f.compid, values });
          if (f.message.name === "PARAM_REQUEST_READ") {
            s.write(dev.frame("PARAM_VALUE", { param_id: "RATE_KP", param_value: 1.25, param_type: 9, param_count: 5, param_index: 0 }));
          }
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await c.request("source.connect", { device: "bench", transport: { kind: "tcp", host: "127.0.0.1", port: (server.address() as AddressInfo).port } });
      while (!conn.socket) await new Promise((r) => setTimeout(r, 10));
      conn.socket.write(dev.dialectInfo());
      await untilRunning(c);
      expect(await c.request("parameters.read", { device: "bench", name: "RATE_KP" })).toEqual({ name: "RATE_KP", value: 1.25, type: "float", index: 0 });
      // from a ground-station address, aimed at the node the telemetry came from
      expect(received[0]).toMatchObject({
        message: "PARAM_REQUEST_READ",
        sysid: 255,
        compid: 190,
        values: { target_system: 1, target_component: 1, param_id: "RATE_KP", param_index: -1 },
      });
    } finally {
      await c.request("source.stop", { device: "bench" });
      conn.socket?.destroy();
      await new Promise((r) => server.close(r));
    }
  });
});
