import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("Attitude 3D Panel renders quaternion and Euler Signal sets on a spherical reference frame", async ({ page }) => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Attitude bench");
    await page.getByLabel("Template").selectOption("virtual-bench");
    await page.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByTestId("project-name")).toHaveText("Attitude bench");

    await page.getByTestId("device-bench").getByRole("button", { name: "Start Virtual Device" }).click();
    await expect(page.getByTestId("device-bench").getByTestId("source-state")).toHaveText("running");

    // Add Attitude 3D Panel
    await page.getByTestId("workspace").getByRole("button", { name: "Add Attitude 3D" }).click();
    const panel = page.getByTestId("attitude-panel-0");

    // 1. Euler Mode
    await panel.getByLabel("Mode").selectOption("euler");
    await panel.getByLabel("Roll").selectOption("bench/BENCH_ATTITUDE.roll");
    await panel.getByLabel("Pitch").selectOption("bench/BENCH_ATTITUDE.pitch");
    await panel.getByLabel("Yaw").selectOption("bench/BENCH_ATTITUDE.yaw");

    const view = panel.getByTestId("attitude-view");
    await expect(view).toHaveAttribute("data-mode", "euler");
    await expect(view).toHaveAttribute("data-rendered", "true");
    await expect(view.locator("canvas")).toBeVisible();

    // Verify Euler rotation updates smoothly at display rate
    await expect.poll(async () => Number(await view.getAttribute("data-updates")), { timeout: 5000 }).toBeGreaterThan(10);
    const initialRoll = await view.getAttribute("data-roll");
    await expect.poll(async () => view.getAttribute("data-roll"), { timeout: 5000 }).not.toBe(initialRoll);

    // 2. Quaternion Mode
    await panel.getByLabel("Mode").selectOption("quaternion");
    await panel.getByLabel("w (qw)").selectOption("bench/BENCH_ATTITUDE.q[0]");
    await panel.getByLabel("x (qx)").selectOption("bench/BENCH_ATTITUDE.q[1]");
    await panel.getByLabel("y (qy)").selectOption("bench/BENCH_ATTITUDE.q[2]");
    await panel.getByLabel("z (qz)").selectOption("bench/BENCH_ATTITUDE.q[3]");

    await expect(view).toHaveAttribute("data-mode", "quaternion");
    await expect.poll(async () => Number(await view.getAttribute("data-updates")), { timeout: 5000 }).toBeGreaterThan(20);

    // Check quaternion normalisation: w^2 + x^2 + y^2 + z^2 ≈ 1
    const quatStr = (await view.getAttribute("data-quaternion"))!;
    const [qw, qx, qy, qz] = quatStr.split(",").map(Number);
    const norm = Math.sqrt(qw! * qw! + qx! * qx! + qy! * qy! + qz! * qz!);
    expect(norm).toBeCloseTo(1.0, 2);

    // 3. Layout Persistence
    await page.waitForTimeout(800);
    await page.reload();
    await expect(panel.getByLabel("Mode")).toHaveValue("quaternion");
    await expect(panel.getByLabel("w (qw)")).toHaveValue("bench/BENCH_ATTITUDE.q[0]");
    await expect(panel.getByLabel("x (qx)")).toHaveValue("bench/BENCH_ATTITUDE.q[1]");
    await expect(view).toBeVisible();

    await page.getByTestId("device-bench").getByRole("button", { name: "Stop" }).click();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
