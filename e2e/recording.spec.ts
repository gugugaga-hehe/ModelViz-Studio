import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("records a Virtual Device and replays it into the plot", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Recording bench");
    await page.getByRole("button", { name: "Create Project" }).click();

    const device = page.getByTestId("device-bench");
    await device.getByRole("button", { name: "Start Virtual Device" }).click();
    await device.getByRole("button", { name: "Record" }).click();
    await expect(device.getByRole("button", { name: /Stop recording/ })).toBeVisible();
    await page.waitForTimeout(1500);
    await device.getByRole("button", { name: /Stop recording/ }).click();
    await device.getByRole("button", { name: "Stop", exact: true }).click();

    const rec = page.locator('[data-testid^="recording-bench-"]');
    await expect(rec).toHaveCount(1);
    await rec.getByRole("button", { name: /Replay/ }).click();
    const controls = device.getByTestId("replay-controls");
    await expect(controls).toBeVisible();
    await expect(device.getByTestId("source-state")).toHaveText("running");

    const panel = page.getByTestId("time-plot-panel-0");
    await panel.getByRole("checkbox", { name: "bench/BENCH_STATE.setpoint" }).check();
    const plot = panel.getByTestId("time-plot");
    await expect.poll(async () => Number(await plot.getAttribute("data-samples"))).toBeGreaterThan(50);

    await controls.getByRole("button", { name: "Pause replay" }).click();
    await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    const pos = await controls.getByTestId("replay-position").innerText();
    await page.waitForTimeout(400);
    expect(await controls.getByTestId("replay-position").innerText()).toBe(pos);
    await controls.getByLabel("Replay speed").selectOption("4");
    await controls.getByRole("button", { name: "Play", exact: true }).click();
    await expect(controls.getByTestId("replay-position")).not.toHaveText(pos);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
