import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("pauses, zooms and resumes live time plots with synchronised cursors", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Interaction bench");
    await page.getByRole("button", { name: "Create Project" }).click();
    await page.getByTestId("device-bench").getByRole("button", { name: "Start Virtual Device" }).click();

    const p1 = page.getByTestId("time-plot-panel-0");
    await p1.getByRole("checkbox", { name: "bench/BENCH_IMU_BATCH.gyro_x" }).check();
    await page.getByRole("button", { name: "Add time plot" }).click();
    const p2 = page.getByTestId("time-plot-panel-1");
    await p2.getByRole("checkbox", { name: "bench/BENCH_STATE.setpoint" }).check();

    const plot1 = p1.getByTestId("time-plot");
    await expect.poll(async () => Number(await plot1.getAttribute("data-samples"))).toBeGreaterThan(2000);

    // UI stays responsive while streaming: animation frames keep coming at display rate
    const frameGaps = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const gaps: number[] = [];
          let last = performance.now();
          const tick = (now: number) => {
            gaps.push(now - last);
            last = now;
            if (gaps.length < 60) requestAnimationFrame(tick);
            else resolve(gaps);
          };
          requestAnimationFrame(tick);
        }),
    );
    const sorted = [...frameGaps].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(50);

    // cursors are synchronised: hovering plot 1 moves the cursor in plot 2
    const cursor2 = p2.locator(".u-cursor-x");
    const box = (await plot1.locator(".u-over").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    const left1 = await cursor2.evaluate((el) => (el as HTMLElement).style.transform);
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    await expect.poll(() => cursor2.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(left1);

    // pause freezes the plot
    await p1.getByRole("button", { name: "Pause" }).click();
    await expect(plot1).toHaveAttribute("data-paused", "true");
    const frozen = await plot1.getAttribute("data-samples");
    await page.waitForTimeout(300);
    expect(await plot1.getAttribute("data-samples")).toBe(frozen);

    // zoom with the wheel while paused changes the visible x range
    const span = async () => Number(await plot1.getAttribute("data-x-span"));
    const before = await span();
    expect(before).toBeCloseTo(10, 0);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -200);
    await expect.poll(span).toBeLessThan(before / 2);

    // resume continues live updates
    await p1.getByRole("button", { name: "Resume" }).click();
    await expect.poll(async () => Number(await plot1.getAttribute("data-samples"))).toBeGreaterThan(Number(frozen));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
