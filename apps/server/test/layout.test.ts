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
    expect(await c.request("layout.get", {})).toEqual({ status: "none" });

    await c.request("layout.set", { layout });
    const text = await readFile(join(path, "layout.yaml"), "utf8");
    expect(parse(text)).toEqual(layout);

    await c.request("project.open", { path });
    expect(await c.request("layout.get", {})).toEqual({ status: "ok", layout });
    // another client (e.g. after a browser reload) sees the same layout
    const other = await h.client();
    expect(await other.request("layout.get", {})).toEqual({ status: "ok", layout });
  });

  it.each([
    ["an unknown (newer) version", "version: 99\ndock: {}\n", /newer ModelViz Studio/],
    ["invalid YAML", "version: 1\ndock: [unclosed\n", /not valid YAML/],
    ["not a layout", "- just\n- a list\n", /not a Panel layout/],
  ])("reports %s as unreadable and never overwrites it", async (_, content, reason) => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    const file = join(path, "layout.yaml");
    await writeFile(file, content);
    expect(await c.request("layout.get", {})).toEqual({ status: "unreadable", reason: expect.stringMatching(reason) });
    await expect(c.request("layout.set", { layout })).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it("keeps a backup when the layout is reset", async () => {
    await using h = await harness();
    const c = await h.client();
    const { path } = await benchProject(h, c);
    expect(await c.request("layout.reset", {})).toEqual({ backup: null });
    await writeFile(join(path, "layout.yaml"), "version: 99\n");
    expect(await c.request("layout.reset", {})).toEqual({ backup: "layout.yaml.bak" });
    expect(await c.request("layout.get", {})).toEqual({ status: "none" });
    await c.request("layout.set", { layout });
    expect(await c.request("layout.get", {})).toEqual({ status: "ok", layout });
    // a second reset does not replace the first backup
    expect(await c.request("layout.reset", {})).toEqual({ backup: "layout.yaml.bak.2" });
    expect(await readFile(join(path, "layout.yaml.bak"), "utf8")).toBe("version: 99\n");
    expect(parse(await readFile(join(path, "layout.yaml.bak.2"), "utf8"))).toEqual(layout);
  });

  it("saves only the current layout version", async () => {
    await using h = await harness();
    const c = await h.client();
    await benchProject(h, c);
    await expect(c.request("layout.set", { layout: { version: 2, dock: {} } as never })).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("needs an open Project", async () => {
    await using h = await harness();
    const c = await h.client();
    await expect(c.request("layout.get", {})).rejects.toMatchObject({ code: "no_project" });
  });
});
