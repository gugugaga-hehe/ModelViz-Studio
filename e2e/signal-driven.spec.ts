import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("drives a System with recorded and live Signals and overlays model and measurement", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Signal bench");
    await page.getByRole("button", { name: "Create Project" }).click();

    const device = page.getByTestId("device-bench");
    await device.getByRole("button", { name: "Start Virtual Device" }).click();
    await expect(device.getByTestId("source-state")).toHaveText("running");

    // live: the rate loop follows the setpoint; plot model output next to the measurement
    const live = page.getByTestId("live-systems");
    await live.getByLabel("System").selectOption({ label: "rate_loop" });
    await live.getByLabel("Input Signal").selectOption("bench/BENCH_STATE.setpoint");
    await live.getByRole("button", { name: "Run live" }).click();
    await expect(live.getByTestId("live-systems/rate_loop.yaml")).toBeVisible();
    const panel = page.getByTestId("time-plot-panel-0");
    await panel.getByRole("checkbox", { name: "bench/BENCH_STATE.setpoint" }).check();
    await panel.getByRole("checkbox", { name: "system:rate_loop/out.y", exact: true }).check();
    const plot = panel.getByTestId("time-plot");
    await expect.poll(async () => Number(await plot.getAttribute("data-samples"))).toBeGreaterThan(1000);

    // record a little, then use the Recording as an Analysis input
    await device.getByRole("button", { name: "Record" }).click();
    await page.waitForTimeout(1000);
    await device.getByRole("button", { name: /Stop recording/ }).click();
    await live.getByRole("button", { name: "Stop live System" }).click();
    await device.getByRole("button", { name: "Stop", exact: true }).click();

    await page.getByRole("tab", { name: "Model Lab" }).click();
    const analysis = page.getByTestId("analysis-panel");
    await analysis.getByLabel("System").selectOption({ label: "rate_loop" });
    await analysis.getByLabel("Analysis", { exact: true }).selectOption("signal");
    await analysis.getByLabel("Input Signal").selectOption("bench/BENCH_STATE.setpoint");
    await analysis.getByLabel("Duration [s]").fill("10");
    await analysis.getByRole("button", { name: "Run" }).click();
    const result = page.getByTestId("analysis-result");
    // limited to the ~1 s Recording at the loop's 1 kHz
    await expect.poll(async () => Number(await result.getAttribute("data-points"))).toBeGreaterThan(500);
    expect(Number(await result.getAttribute("data-points"))).toBeLessThan(2000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
