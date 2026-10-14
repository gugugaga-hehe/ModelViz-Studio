import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { EventData } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { benchProject, editYaml, harness } from "./harness.ts";

type H = Awaited<ReturnType<typeof harness>>;

const KP = { system: "systems/rate_loop.yaml", block: "controller", parameter: "Kp", device: "bench", deviceParameter: "RATE_KP" };
const KI = { ...KP, parameter: "Ki", deviceParameter: "RATE_KI" };
const FC = { ...KP, block: "sensor", parameter: "fc", deviceParameter: "GYRO_LPF_HZ" };

async function untilRunning(c: ModelVizClient): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await c.request("sources.list", {})).some((s) => s.device === "bench" && s.state === "running")) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("bench did not reach running");
}

/** The example bench Project running as a Virtual Device; `override` edits the rate loop's controller. */
async function bench(h: H) {
  const c = await h.client();
  const { path } = await benchProject(h, c);
  await c.request("source.startVirtual", { device: "bench" });
  await untilRunning(c);
  const override = (params: Record<string, number>) =>
    editYaml(join(path, "systems/rate_loop.yaml"), (doc) => {
      doc.blocks.controller.parameters = params;
    });
  const device = async (name: string) => (await c.request("parameters.read", { device: "bench", name })).value;
  return { c, path, override, device };
}

describe("Parameter Mappings", () => {
  it("are stored in the Project and resolve to the Block Parameters' values", async () => {
    await using h = await harness();
    const { c, path, override } = await bench(h);
    expect(await c.request("mappings.list", {})).toEqual([
      { ...KP, blockValue: 0.8 },
      { ...KI, blockValue: 40 },
      { ...FC, blockValue: 80 },
    ]);
    // a System Block override wins over the Block's default
    await override({ Kp: 1.5 });
    expect((await c.request("mappings.list", {}))[0]).toMatchObject({ blockValue: 1.5 });

    const set = await c.request("mappings.set", { mappings: [KI, { ...KP, parameter: "Nope" }, { ...KP, device: "ghost" }] });
    expect(set).toEqual([
      { ...KI, blockValue: 40 },
      { ...KP, parameter: "Nope", issue: "controller has no Block Parameter Nope" },
      { ...KP, device: "ghost", issue: "Unknown Device ghost" },
    ]);
    const manifest = parse(await readFile(join(path, "project.yaml"), "utf8"));
    expect(manifest.parameterMappings).toEqual([KI, { ...KP, parameter: "Nope" }, { ...KP, device: "ghost" }]);
    expect(manifest.devices[0].id).toBe("bench");
    // survives reopening the Project
    await c.request("project.open", { path });
    expect(await c.request("mappings.list", {})).toHaveLength(3);

    await expect(c.request("mappings.set", { mappings: [KP, { ...KI, deviceParameter: "RATE_KP" }] })).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringMatching(/bench\/RATE_KP is mapped more than once/),
    });
  });
});

describe("Push", () => {
  it("previews the differences without writing, then writes only what was confirmed", async () => {
    await using h = await harness();
    const { c, override, device } = await bench(h);
    await override({ Kp: 1.5 });

    const preview = await c.request("push.preview", { device: "bench" });
    expect(preview.entries.map((e) => [e.mapping.deviceParameter, e.current?.value, e.proposed, e.status])).toEqual([
      ["RATE_KP", Math.fround(0.8), 1.5, "changed"],
      ["RATE_KI", 40, 40, "unchanged"],
      ["GYRO_LPF_HZ", 80, 80, "unchanged"],
    ]);
    // the preview only read from the Device
    expect(await device("RATE_KP")).toBe(Math.fround(0.8));

    const writes: EventData<"parameters.changed">[] = [];
    c.on("parameters.changed", (e) => writes.push(e));
    const result = await c.request("push.apply", { id: preview.id });
    expect(result.results.map((r) => [r.mapping.deviceParameter, r.outcome, r.parameter?.value])).toEqual([
      ["RATE_KP", "acknowledged", 1.5],
      ["RATE_KI", "not_written", undefined],
      ["GYRO_LPF_HZ", "not_written", undefined],
    ]);
    expect(new Set(writes.map((w) => w.parameter.name))).toEqual(new Set(["RATE_KP"]));
    expect(await device("RATE_KP")).toBe(1.5);

    // a preview is applied at most once
    await expect(c.request("push.apply", { id: preview.id })).rejects.toMatchObject({ code: "not_found" });
    // and now the Device matches
    expect((await c.request("push.preview", { device: "bench" })).entries.every((e) => e.status === "unchanged")).toBe(true);
  });

  it("reports per-parameter success or failure", async () => {
    await using h = await harness();
    const { c, override, device } = await bench(h);
    await c.request("mappings.set", {
      mappings: [
        KP,
        KI,
        { ...FC, deviceParameter: "NO_SUCH" },
        { ...KP, parameter: "Ki", deviceParameter: "CTRL_MODE" },
      ],
    });
    // Kp = 9 is outside RATE_KP's range on the Device; Ki = 50 also goes to CTRL_MODE (Device range 0..3)
    await override({ Kp: 9, Ki: 50 });

    const preview = await c.request("push.preview", { device: "bench" });
    const byName = Object.fromEntries(preview.entries.map((e) => [e.mapping.deviceParameter, e]));
    expect(byName.RATE_KP).toMatchObject({ status: "changed", proposed: 9 });
    expect(byName.RATE_KI).toMatchObject({ status: "changed", proposed: 50 });
    expect(byName.NO_SUCH).toMatchObject({ status: "unavailable", message: expect.stringMatching(/No answer from the Device/) });
    expect(byName.CTRL_MODE).toMatchObject({ status: "changed", proposed: 50 });

    const { results } = await c.request("push.apply", { id: preview.id });
    const out = Object.fromEntries(results.map((r) => [r.mapping.deviceParameter, r]));
    expect(out.RATE_KP).toMatchObject({ outcome: "refused", parameter: { value: Math.fround(0.8) } });
    expect(out.RATE_KI).toMatchObject({ outcome: "acknowledged", parameter: { value: 50 } });
    expect(out.NO_SUCH).toMatchObject({ outcome: "not_written" });
    // CTRL_MODE accepts 0..3 on the Device
    expect(out.CTRL_MODE).toMatchObject({ outcome: "refused", parameter: { value: 1 } });
    expect(await device("RATE_KI")).toBe(50);

    // values that cannot be stored in the Device Parameter's type are never sent
    await override({ Kp: 0.8, Ki: 1.5 });
    const p2 = await c.request("push.preview", { device: "bench" });
    expect(p2.entries.find((e) => e.mapping.deviceParameter === "CTRL_MODE")).toMatchObject({
      status: "invalid",
      message: "1.5 cannot be stored in a uint8 Device Parameter",
    });
  }, 20000);

  it("refuses a confirmation when Block Parameters changed after the preview", async () => {
    await using h = await harness();
    const { c, override, device } = await bench(h);
    await override({ Kp: 1.5 });
    const preview = await c.request("push.preview", { device: "bench" });
    await override({ Kp: 2 });
    await expect(c.request("push.apply", { id: preview.id })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/controller\.Kp changed since the preview/),
    });
    expect(await device("RATE_KP")).toBe(Math.fround(0.8));
  });

  it("is the only way Block Parameter values reach the Device", async () => {
    await using h = await harness();
    const { c, path, override, device } = await bench(h);
    expect(await device("RATE_KP")).toBe(Math.fround(0.8));
    const writes: EventData<"parameters.changed">[] = [];
    c.on("parameters.changed", (e) => writes.push(e));
    // change Block Parameters every way the workbench offers, and use them
    await override({ Kp: 2, Ki: 60 });
    await c.request("files.write", { path: "blocks/gyro-lpf.yaml", content: (await readFile(join(path, "blocks/gyro-lpf.yaml"), "utf8")).replace("default: 80", "default: 120") });
    await c.request("mappings.set", { mappings: [KP, KI, FC] });
    await c.request("analysis.time", { system: "systems/rate_loop.yaml", kind: "step", durationS: 0.1, parameters: { controller: { Kp: 3 } } });
    expect((await c.request("mappings.list", {})).map((m) => m.blockValue)).toEqual([2, 60, 120]);
    await new Promise((r) => setTimeout(r, 300));
    expect(writes).toEqual([]);
    expect(await device("RATE_KP")).toBe(Math.fround(0.8));
    expect(await device("RATE_KI")).toBe(40);
    expect(await device("GYRO_LPF_HZ")).toBe(80);
  });

  it("needs a running Source that can reach the Device", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    await expect(c.request("push.preview", { device: "bench" })).rejects.toMatchObject({ code: "conflict" });
    await expect(c.request("push.apply", { id: "push-1" })).rejects.toMatchObject({ code: "not_found" });
  });
});
