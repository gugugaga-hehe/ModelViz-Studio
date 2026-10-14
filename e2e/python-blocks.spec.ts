import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("edits and runs a Python Block in a System", async ({ page }) => {
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    const path = join(dir, "py");
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(path);
    await page.getByLabel("Name").fill("Python blocks");
    await page.getByLabel("Template").selectOption("empty");
    await page.getByRole("button", { name: "Create Project" }).click();

    // files a user would author (written directly, then the Project is reopened)
    await mkdir(join(path, "python"));
    await mkdir(join(path, "blocks"));
    await mkdir(join(path, "systems"));
    await writeFile(
      join(path, "python/limiter.py"),
      "class Block:\n    def __init__(self, params, sample_rate):\n        self.limit = params['limit']\n    def process(self, t, inputs):\n        print('limiter ran', end='')\n        return {'y': [max(-self.limit, min(self.limit, 2 * u)) for u in inputs['u']]}\n",
    );
    await writeFile(join(path, "blocks/limiter.yaml"), "kind: python\nmodule: python/limiter.py\nparameters:\n  limit: { default: 1 }\n");
    await writeFile(
      join(path, "systems/limit.yaml"),
      "sampleRateHz: 1000\ninputs: [r]\nblocks:\n  g: { block: blocks/limiter.yaml }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n",
    );
    await writeFile(join(path, "python/stuck.py"), "class Block:\n    def __init__(self, params, sample_rate):\n        pass\n    def process(self, t, inputs):\n        while True:\n            pass\n");
    await writeFile(join(path, "blocks/stuck.yaml"), "kind: python\nmodule: python/stuck.py\n");
    await writeFile(
      join(path, "systems/stuck.yaml"),
      "sampleRateHz: 1000\ninputs: [r]\nblocks:\n  g: { block: blocks/stuck.yaml }\nconnections:\n  - { from: r, to: g.u }\noutputs: { y: g.y }\n",
    );
    await page.getByRole("button", { name: "Switch Project" }).click();
    await page.getByLabel("Folder (absolute path)").fill(path);
    await page.getByRole("button", { name: "Open Project" }).click();
    await page.getByRole("tab", { name: "Model Lab" }).click();

    const py = page.getByTestId("python-panel");
    await py.getByRole("button", { name: "Set up Python environment…" }).click();
    await py.getByRole("button", { name: "Apply" }).click();
    await expect(py).toHaveAttribute("data-state", "ready", { timeout: 90000 });

    // the module is editable next to its Block
    await page.getByRole("button", { name: "↳ python/limiter.py" }).click();
    await expect(page.getByLabel("File content")).toHaveValue(/class Block/);

    const analysis = page.getByTestId("analysis-panel");
    await analysis.getByLabel("System").selectOption({ label: "limit" });
    await analysis.getByLabel("Duration [s]").fill("0.2");
    await analysis.getByRole("button", { name: "Run" }).click();
    const result = page.getByTestId("analysis-result");
    await expect(result).toHaveAttribute("data-points", "201");
    // step of 1 through 2·u limited to ±1
    expect(JSON.parse((await result.getAttribute("data-final"))!).y).toBe(1);

    // what the Block printed is shown, even without a trailing newline
    const output = py.getByTestId("python-output");
    await output.getByText("Block output").click();
    await expect(output).toContainText("limiter ran");

    // a Block that never returns can be cancelled
    await analysis.getByLabel("System").selectOption({ label: "stuck" });
    await analysis.getByRole("button", { name: "Run" }).click();
    await analysis.getByRole("button", { name: "Cancel" }).click();
    await expect(analysis.getByRole("alert")).toContainText("cancelled");
    await expect(analysis.getByRole("button", { name: "Run" })).toBeEnabled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
