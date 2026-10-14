import { execFileSync, spawnSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ModelVizClient } from "@modelviz/client";
import type { PythonStatus } from "@modelviz/protocol";
import { describe, expect, it } from "vitest";
import { harness } from "./harness.ts";

const hasUv = spawnSync("uv", ["--version"]).status === 0;

function waitForPython(c: ModelVizClient, state: PythonStatus["state"], timeoutMs = 60000): Promise<PythonStatus> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for Python ${state}`));
    }, timeoutMs);
    const off = c.on("python.changed", (s) => {
      if (s.state === state || (s.state === "failed" && state !== "failed")) {
        clearTimeout(timer);
        off();
        if (s.state !== state) reject(new Error(`Python ${s.state}: ${s.error}`));
        else resolve(s);
      }
    });
  });
}

/** Builds a tiny pure-Python wheel offline, so tests need no package index. */
function buildWheel(dir: string, version = "0.1.0"): string {
  const file = join(dir, `mvdemo-${version}-py3-none-any.whl`);
  const script = `
import zipfile, sys, hashlib, base64
path, version = sys.argv[1], sys.argv[2]
files = {
  "mvdemo/__init__.py": f"VERSION = '{version}'\\n",
  f"mvdemo-{version}.dist-info/METADATA": f"Metadata-Version: 2.1\\nName: mvdemo\\nVersion: {version}\\n",
  f"mvdemo-{version}.dist-info/WHEEL": "Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}
def h(b): return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b"=").decode()
record = "".join(f"{n},{h(c.encode())},{len(c.encode())}\\n" for n, c in files.items()) + f"mvdemo-{version}.dist-info/RECORD,,\\n"
with zipfile.ZipFile(path, "w") as z:
  for n, c in files.items(): z.writestr(n, c)
  z.writestr(f"mvdemo-{version}.dist-info/RECORD", record)
`;
  execFileSync("python3", ["-c", script, file, version]);
  return file;
}

const py = (project: string, code: string) => spawnSync(join(project, ".venv/bin/python"), ["-c", code], { encoding: "utf8" });

describe.skipIf(!hasUv)("per-Project Python environment (ADR-0005)", () => {
  it("is absent until the Project declares one", async () => {
    await using h = await harness();
    const c = await h.client();
    await c.request("project.create", { path: join(h.dir, "p"), name: "p" });
    expect(await c.request("python.status", {})).toMatchObject({ state: "absent" });
  });

  it("creates the environment from declared dependencies, with a committed lock file", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = join(h.dir, "p");
    await c.request("project.create", { path, name: "p" });
    const wheel = buildWheel(h.dir);
    const seen: string[] = [];
    c.on("python.changed", (s) => seen.push(s.state));
    const ready = waitForPython(c, "ready");
    await c.request("python.configure", { dependencies: [`mvdemo @ file://${wheel}`] });
    const st = await ready;
    expect(seen[0]).toBe("preparing");
    expect(st.version).toMatch(/^3\.\d+\.\d+$/);
    expect(st.locked.join("\n")).toContain("mvdemo @ file://");
    expect(st.log.length).toBeGreaterThan(0);

    expect(py(path, "import mvdemo; print(mvdemo.VERSION)").stdout.trim()).toBe("0.1.0");
    expect(await readFile(join(path, "project.yaml"), "utf8")).toMatch(/python:\n\s+dependencies:\n\s+- mvdemo @ file:/);
    expect(await readFile(join(path, "requirements.lock"), "utf8")).toMatch(/^# modelviz-dependencies: [0-9a-f]{16}\n/);
    expect(await readFile(join(path, ".gitignore"), "utf8")).toContain(".venv/");
    expect(await c.request("python.status", {})).toMatchObject({ state: "ready" });
  }, 120000);

  it("re-syncs when the declaration changes and rebuilds from the lock file", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = join(h.dir, "p");
    await c.request("project.create", { path, name: "p" });
    const wheel = buildWheel(h.dir);
    let ready = waitForPython(c, "ready");
    await c.request("python.configure", { dependencies: [`mvdemo @ file://${wheel}`] });
    await ready;
    const lock = await readFile(join(path, "requirements.lock"), "utf8");

    // the environment is disposable: delete it and reopen the Project
    await rm(join(path, ".venv"), { recursive: true, force: true });
    ready = waitForPython(c, "ready");
    await c.request("project.open", { path });
    await ready;
    expect(py(path, "import mvdemo").status).toBe(0);
    expect(await readFile(join(path, "requirements.lock"), "utf8")).toBe(lock);

    // removing the dependency removes the package
    ready = waitForPython(c, "ready");
    await c.request("python.configure", { dependencies: [] });
    expect((await ready).locked).toEqual([]);
    expect(py(path, "import mvdemo").status).not.toBe(0);
  }, 180000);

  it("reports failures and recovers on retry", async () => {
    await using h = await harness();
    const c = await h.client();
    const path = join(h.dir, "p");
    await c.request("project.create", { path, name: "p" });
    const failed = waitForPython(c, "failed");
    await c.request("python.configure", { dependencies: [`mvdemo @ file://${join(h.dir, "missing.whl")}`] });
    expect((await failed).error).toMatch(/missing\.whl|not found|No such file/i);
    // fix the declaration and retry
    const wheel = buildWheel(h.dir);
    const ready = waitForPython(c, "ready");
    await c.request("python.configure", { dependencies: [`mvdemo @ file://${wheel}`] });
    await ready;
    expect((await stat(join(path, ".venv"))).isDirectory()).toBe(true);
  }, 120000);
});
