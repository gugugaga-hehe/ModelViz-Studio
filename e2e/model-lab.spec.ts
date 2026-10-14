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
    await expect(page.getByTestId("step-metrics").getByTestId("metrics-y").locator('[data-metric="overshootPercent"]')).toHaveText(/^\d/);

    // Bode with the loop broken at the Plant input, and the pole-zero map (PI 1 + Plant 2 + filter 1 states)
    await analysis.getByLabel("Analysis", { exact: true }).selectOption("bode");
    await analysis.getByLabel("Loop broken at").selectOption("plant.u");
    await analysis.getByRole("button", { name: "Run" }).click();
    const bode = page.getByTestId("bode-result");
    await expect(bode).toHaveAttribute("data-method", "analytic");
    await expect(bode).toContainText("analytic");
    await expect(page.getByTestId("loop-metrics").locator('[data-metric="phaseMarginDeg"]')).toHaveText(/^\d/);
    // the same loop, measured by simulation
    await analysis.getByLabel("Method").selectOption("measured");
    await analysis.getByRole("button", { name: "Run" }).click();
    await expect(bode).toHaveAttribute("data-method", "measured", { timeout: 20000 });
    await expect(bode).toContainText("measured");
    await analysis.getByLabel("Method").selectOption("auto");
    await analysis.getByLabel("Analysis", { exact: true }).selectOption("polezero");
    await analysis.getByRole("button", { name: "Run" }).click();
    await expect(page.getByTestId("pole-zero-plot")).toHaveAttribute("data-poles", "4");
    await expect(page.getByTestId("pole-zero-plot")).toContainText("stable");
    await analysis.getByLabel("Analysis", { exact: true }).selectOption("step");

    // Discretization of the gyro filter: compare and save
    await page.getByRole("button", { name: /^gyro-lpf\.yaml/ }).click();
    await page.getByRole("tab", { name: "Discretization" }).click();
    const disc = page.getByTestId("discretize-panel");
    await disc.getByLabel("Method").selectOption("zoh");
    await disc.getByRole("button", { name: "Compare" }).click();
    await expect(disc.getByTestId("disc-plot")).toHaveAttribute("data-points", "501");
    await expect(disc.getByTestId("disc-error")).toContainText(/Largest difference: [0-9.e-]+/);
    await disc.getByLabel("Save as").fill("blocks/gyro-lpf-1k.yaml");
    await disc.getByRole("button", { name: "Save discrete Block" }).click();
    await expect(disc.getByRole("status")).toHaveText("Saved blocks/gyro-lpf-1k.yaml");
    await expect(page.getByRole("button", { name: /^gyro-lpf-1k\.yaml/ })).toBeVisible();
    await page.getByRole("tab", { name: "Analysis" }).click();

    // break a Block: the editor shows the problem
    await page.getByRole("button", { name: /^plant\.yaml/ }).click();
    const editor = page.getByLabel("File content");
    await expect(editor).toHaveValue(/Rate Plant/);
    await editor.fill((await editor.inputValue()).replace('denominator: [1, "2*zeta*wn", "wn^2"]', "denominator: [1, oops]"));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert", { name: "Issues" })).toContainText('Unknown name "oops"');

    // a new System from the Loop Template (Plant fixed again first)
    await editor.fill((await editor.inputValue()).replace("denominator: [1, oops]", "denominator: [1, 1]"));
    await page.getByRole("button", { name: "Save", exact: true }).click();
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
