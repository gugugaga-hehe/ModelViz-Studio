import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

/** --mv-border in index.css, which plots use for their grid. */
const GRID = { light: "#e2e5ea", dark: "#2a2f3a" };

test("plots follow a colour-scheme switch without re-running anything", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Theme bench");
    await page.getByRole("button", { name: "Create Project" }).click();
    await page.getByTestId("device-bench").getByRole("button", { name: "Start Virtual Device" }).click();

    // a live time plot…
    const panel = page.getByTestId("time-plot-panel-0");
    await panel.getByRole("checkbox", { name: "bench/BENCH_STATE.setpoint" }).check();
    const plot = panel.getByTestId("time-plot");
    await expect(plot).toHaveAttribute("data-grid-color", GRID.dark);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(plot).toHaveAttribute("data-grid-color", GRID.light);
    await expect.poll(async () => Number(await plot.getAttribute("data-samples"))).toBeGreaterThan(0);

    // …and an Analysis result
    await page.getByRole("tab", { name: "Model Lab" }).click();
    const analysis = page.getByTestId("analysis-panel");
    await analysis.getByRole("button", { name: "Run" }).click();
    const result = page.getByTestId("analysis-result").locator("[data-grid-color]");
    await expect(result).toHaveAttribute("data-grid-color", GRID.light);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(result).toHaveAttribute("data-grid-color", GRID.dark);
    // the plot was redrawn, not left empty
    await expect(page.getByTestId("analysis-result").locator("canvas")).toHaveCount(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
