import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("runs 1-D and 2-D Parameter Sweeps with progress and cancellation", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Sweep bench");
    await page.getByRole("button", { name: "Create Project" }).click();
    await page.getByRole("tab", { name: "Model Lab" }).click();
    await page.getByRole("tab", { name: "Parameter Sweep" }).click();

    const panel = page.getByTestId("sweep-panel");
    await panel.getByLabel("Metric").selectOption("phaseMarginDeg");
    await panel.getByLabel("Loop broken at").selectOption("plant.u");
    await panel.getByLabel("Axis 1 Block", { exact: true }).selectOption("controller");
    await panel.getByLabel("Axis 1 Block Parameter").selectOption("Kp");
    await panel.getByLabel("Axis 1 from").fill("0.2");
    await panel.getByLabel("Axis 1 to").fill("2");
    await panel.getByLabel("Axis 1 steps").fill("10");
    await panel.getByRole("button", { name: "Run sweep" }).click();
    await expect(panel.getByTestId("sweep-curve")).toHaveAttribute("data-points", "10");

    await panel.getByRole("button", { name: /Add second axis/ }).click();
    await panel.getByLabel("Axis 2 Block", { exact: true }).selectOption("controller");
    await panel.getByLabel("Axis 2 Block Parameter").selectOption("Ki");
    await panel.getByLabel("Axis 2 from").fill("10");
    await panel.getByLabel("Axis 2 to").fill("100");
    await panel.getByLabel("Axis 2 steps").fill("8");
    await panel.getByRole("button", { name: "Run sweep" }).click();
    const map = panel.getByTestId("sweep-heatmap");
    await expect(map).toHaveAttribute("data-rows", "10");
    await expect(map).toHaveAttribute("data-cols", "8");
    await map.locator("canvas").hover();
    await expect(panel.getByTestId("heatmap-hover")).toContainText(/controller\.Kp = .* → Phase margin \[°\] = \d/);

    // a big step-response sweep can be cancelled
    await panel.getByLabel("Metric").selectOption("settlingTimeS");
    await panel.getByLabel("Duration [s]").fill("5");
    await panel.getByLabel("Axis 1 steps").fill("100");
    await panel.getByLabel("Axis 2 steps").fill("100");
    await panel.getByRole("button", { name: "Run sweep" }).click();
    await expect(panel.getByTestId("sweep-progress")).toHaveText(/^\d+\/10000$/);
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel.getByRole("alert")).toContainText("cancelled");
    await expect(panel.getByRole("button", { name: "Run sweep" })).toBeEnabled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
