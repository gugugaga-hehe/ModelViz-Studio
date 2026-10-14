import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harness } from "./harness.ts";

describe("Project", () => {
  it("creates a Project as a folder of diffable text files", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = join(h.dir, "bench");
    const info = await c.request("project.create", { path, name: "Bench rig" });
    expect(info).toEqual({ path, name: "Bench rig" });
    const manifest = await readFile(join(path, "project.yaml"), "utf8");
    expect(manifest).toContain("name: Bench rig");
    expect(manifest).toContain("schemaVersion: 1");
    expect(await readFile(join(path, ".gitignore"), "utf8")).toContain("recordings/");
  });

  it("reopens an existing Project with the same identity", async () => {
    await using h = await harness();
    const path = join(h.dir, "bench");
    await (await h.client()).request("project.create", { path, name: "Bench rig" });
    await h.restartServer();
    const c = await h.client();
    expect(await c.request("project.current", {})).toBeNull();
    expect(await c.request("project.open", { path })).toEqual({ path, name: "Bench rig" });
    expect(await c.request("project.current", {})).toEqual({ path, name: "Bench rig" });
  });

  it("refuses to create a Project in a non-empty folder", async () => {
    await using h = await harness();
    const path = join(h.dir, "occupied");
    await mkdir(path);
    await writeFile(join(path, "something.txt"), "x");
    const c = await h.client();
    await expect(c.request("project.create", { path, name: "X" })).rejects.toMatchObject({ code: "already_exists" });
  });

  it("reports a missing Project", async () => {
    await using h = await harness();
    const c = await h.client();
    await expect(c.request("project.open", { path: join(h.dir, "nope") })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("reports an invalid manifest", async () => {
    await using h = await harness();
    const path = join(h.dir, "broken");
    await mkdir(path);
    await writeFile(join(path, "project.yaml"), "schemaVersion: 99\n");
    const c = await h.client();
    await expect(c.request("project.open", { path })).rejects.toMatchObject({ code: "invalid_project" });
  });

  it("requires absolute paths", async () => {
    await using h = await harness();
    const c = await h.client();
    await expect(c.request("project.open", { path: "relative/dir" })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("validates request params", async () => {
    await using h = await harness();
    const c = await h.client();
    // @ts-expect-error deliberately missing name
    await expect(c.request("project.create", { path: "/tmp/x" })).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("notifies every connected client when the Project changes", async () => {
    await using h = await harness();
    const a = await h.client();
    const b = await h.client();
    const seen = new Promise((resolve) => b.on("project.changed", resolve));
    const path = join(h.dir, "shared");
    await a.request("project.create", { path, name: "Shared" });
    expect(await seen).toEqual({ path, name: "Shared" });
  });
});
