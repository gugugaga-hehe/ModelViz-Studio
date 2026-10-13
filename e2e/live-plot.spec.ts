import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("plots live Signals from a Virtual Device", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Live bench");
    await page.getByLabel("Template").selectOption("virtual-bench");
    await page.getByRole("button", { name: "Create Project" }).click();

    await expect(page.getByTestId("project-name")).toHaveText("Live bench");
    await page.getByTestId("device-bench").getByRole("button", { name: "Start Virtual Device" }).click();
    await expect(page.getByTestId("device-bench").getByTestId("source-state")).toHaveText("running");

    const health = page.getByTestId("link-health-bench");
    await expect(health.getByTestId("message-health-BENCH_STATE")).toContainText("/500");
    await expect(health).toContainText("CRC errors0");

    await page.getByRole("checkbox", { name: "bench/BENCH_STATE.gyro_x" }).check();
    const plot = page.getByTestId("time-plot");
    await expect(plot.locator("canvas")).toBeVisible();
    await expect.poll(async () => Number(await plot.getAttribute("data-samples")), { timeout: 5000 }).toBeGreaterThan(100);
    const first = Number(await plot.getAttribute("data-samples"));
    await expect.poll(async () => Number(await plot.getAttribute("data-samples"))).toBeGreaterThan(first);

    // batched 1 kHz Signal plots alongside
    await page.getByRole("checkbox", { name: "bench/BENCH_IMU_BATCH.gyro_x" }).check();
    await expect.poll(async () => Number(await plot.getAttribute("data-samples"))).toBeGreaterThan(first + 1000);

    await page.getByTestId("device-bench").getByRole("button", { name: "Stop" }).click();
    await expect(page.getByTestId("device-bench").getByTestId("source-state")).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
