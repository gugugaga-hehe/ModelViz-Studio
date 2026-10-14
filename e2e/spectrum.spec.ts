import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("FFT/PSD Panel with selectable window and length", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Spectrum bench");
    await page.getByLabel("Template").selectOption("virtual-bench");
    await page.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByTestId("project-name")).toHaveText("Spectrum bench");
    await page.getByTestId("device-bench").getByRole("button", { name: "Start Virtual Device" }).click();

    await page.getByTestId("workspace").getByRole("button", { name: "Add FFT/PSD" }).click();
    const panel = page.getByTestId("spectrum-panel-0");
    await panel.getByLabel("Signal").selectOption("bench/BENCH_IMU_BATCH.gyro_x");
    const spectrum = panel.getByTestId("spectrum");
    await expect(spectrum).toHaveAttribute("data-window", "hann");
    await expect(spectrum.locator("canvas")).toBeVisible();
    await expect(panel.getByTestId("spectrum-info")).toContainText("peak");

    await panel.getByLabel("Window").selectOption("flattop");
    await panel.getByLabel("Length (samples)").selectOption("2048");
    await expect(spectrum).toHaveAttribute("data-window", "flattop");
    await expect(spectrum).toHaveAttribute("data-length", "2048");
    await expect(spectrum).toHaveAttribute("data-bins", "1025");
    await panel.getByLabel("Scale").selectOption("psd");
    await panel.getByLabel("Decibels").check();
    await expect(spectrum.locator(".u-axis")).not.toHaveCount(0);

    // the Panel's settings are part of the saved layout
    await page.waitForTimeout(800);
    await page.reload();
    await expect(panel.getByLabel("Window")).toHaveValue("flattop");
    await expect(panel.getByLabel("Length (samples)")).toHaveValue("2048");
    await expect(panel.getByLabel("Scale")).toHaveValue("psd");
    await expect(panel.getByLabel("Signal")).toHaveValue("bench/BENCH_IMU_BATCH.gyro_x");

    await page.getByTestId("device-bench").getByRole("button", { name: "Stop" }).click();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
