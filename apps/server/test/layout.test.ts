import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { benchProject, harness } from "./harness.ts";

const layout = {
  version: 1 as const,
  dock: { grid: { orientation: "HORIZONTAL" }, panels: { "time-1": { params: { signals: ["bench/BENCH_STATE.setpoint"] } } } },
};

describe("Panel layout", () => {
  it("is stored in the Project as text and restored on reopen", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    expect(await c.request("layout.get", {})).toBeNull();

    await c.request("layout.set", { layout });
    const text = await readFile(join(path, "layout.yaml"), "utf8");
    expect(parse(text)).toEqual(layout);

    await c.request("project.open", { path });
    expect(await c.request("layout.get", {})).toEqual(layout);
    // another client (e.g. after a browser reload) sees the same layout
    const other = await h.client();
    expect(await other.request("layout.get", {})).toEqual(layout);
  });

  it("starts fresh when the layout file is unreadable, and rejects malformed layouts", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    await writeFile(join(path, "layout.yaml"), "version: 99\n");
    expect(await c.request("layout.get", {})).toBeNull();
    await expect(c.request("layout.set", { layout: { version: 2, dock: {} } as never })).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("needs an open Project", async () => {
    await using h = await harness();
    const c = await h.client();
    await expect(c.request("layout.get", {})).rejects.toMatchObject({ code: "no_project" });
  });
});
