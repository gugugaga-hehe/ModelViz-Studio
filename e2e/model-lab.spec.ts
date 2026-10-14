import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("edits Blocks, builds a System from the Loop Template and runs a step response", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Model bench");
    await page.getByRole("button", { name: "Create Project" }).click();
    await page.getByRole("tab", { name: "Model Lab" }).click();

    // run the example rate loop: PI control gives zero steady-state error
    const analysis = page.getByTestId("analysis-panel");
    await analysis.getByLabel("System").selectOption({ label: "rate_loop" });
    await analysis.getByLabel("Duration [s]").fill("0.5");
    await analysis.getByRole("button", { name: "Run" }).click();
    const result = page.getByTestId("analysis-result");
    await expect(result).toHaveAttribute("data-points", "501");
    const final = JSON.parse((await result.getAttribute("data-final"))!) as Record<string, number>;
    expect(final.y).toBeCloseTo(1, 2);
    await expect(result.locator("canvas")).toBeVisible();

    // break a Block: the editor shows the problem
    await page.getByRole("button", { name: /^plant\.yaml/ }).click();
    const editor = page.getByLabel("File content");
    await expect(editor).toHaveValue(/kind: transfer-function/);
    await editor.fill((await editor.inputValue()).replace('denominator: [1, "2*zeta*wn", "wn^2"]', "denominator: [1, oops]"));
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert", { name: "Issues" })).toContainText('Unknown name "oops"');

    // a new System from the Loop Template (Plant fixed again first)
    await editor.fill((await editor.inputValue()).replace("denominator: [1, oops]", "denominator: [1, 1]"));
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert", { name: "Issues" })).toHaveCount(0);
    await page.getByRole("button", { name: "Loop Template" }).click();
    const form = page.getByRole("form", { name: "New System from the Loop Template" });
    await form.getByLabel("System name").fill("simple");
    await form.getByLabel("Controller", { exact: true }).selectOption("blocks/pi.yaml");
    await form.getByLabel("Plant", { exact: true }).selectOption("blocks/plant.yaml");
    await form.getByRole("button", { name: "Create System" }).click();
    await expect(editor).toHaveValue(/Loop Template/);
    await expect(page.getByRole("button", { name: "simple" })).toBeVisible();
    await analysis.getByRole("button", { name: "Run" }).click();
    await expect(result).toHaveAttribute("data-points", "501");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
