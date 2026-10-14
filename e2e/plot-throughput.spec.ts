import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

const RATE_HZ = 8000;
const CHANNELS = 4;

test("time plot keeps display rate with several 8 kHz Signals and keeps peaks visible", async ({ page }) => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    const path = join(dir, "fast");
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(path);
    await page.getByLabel("Name").fill("fast");
    await page.getByLabel("Template").selectOption("empty");
    await page.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByTestId("project-name")).toHaveText("fast");

    // an 8 kHz Virtual Device: ch0 is a 1 kHz sine (8 samples per cycle), the rest ramps
    await mkdir(join(path, "dialects"));
    await copyFile(join(import.meta.dirname, "../apps/server/test/fixtures/throughput.xml"), join(path, "dialects/fast.xml"));
    await writeFile(
      join(path, "fast.yaml"),
      `framing: mavlink2\ndialect: dialects/fast.xml\nmessages:\n  FAST:\n    deviceTimestamp: { field: time_us, unit: us }\n    nominalRateHz: ${RATE_HZ}\n`,
    );
    const fields = Object.fromEntries(
      Array.from({ length: CHANNELS }, (_, i) => [`ch${i}`, i === 0 ? { kind: "sine", freqHz: 1000, amplitude: 5 } : { kind: "ramp", start: i, step: 1 }]),
    );
    await writeFile(
      join(path, "project.yaml"),
      JSON.stringify({ schemaVersion: 1, name: "fast", devices: [{ id: "fast", frameFormat: "fast.yaml", virtual: { messages: { FAST: { rateHz: RATE_HZ, fields } } } }] }),
    );
    await page.getByRole("button", { name: "Switch Project" }).click();
    await page.getByLabel("Folder (absolute path)").fill(path);
    await page.getByRole("button", { name: "Open Project" }).click();
    await page.getByTestId("device-fast").getByRole("button", { name: "Start Virtual Device" }).click();

    const panel = page.getByTestId("time-plot-panel-0");
    for (let i = 0; i < CHANNELS; i++) await panel.getByRole("checkbox", { name: `fast/FAST.ch${i}`, exact: true }).check();
    const plot = panel.getByTestId("time-plot");
    const num = async (attr: string) => Number(await plot.getAttribute(attr));
    // a full 10 s window of 8 kHz data per Signal
    await expect.poll(() => num("data-samples"), { timeout: 30000 }).toBeGreaterThan(RATE_HZ * CHANNELS * 11);

    // the plot keeps updating at display rate…
    const frames = await num("data-frames");
    await page.waitForTimeout(1000);
    expect((await num("data-frames")) - frames).toBeGreaterThan(15);
    const gaps = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const out: number[] = [];
          let last = performance.now();
          const tick = (now: number) => {
            out.push(now - last);
            last = now;
            if (out.length < 60) requestAnimationFrame(tick);
            else resolve(out);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect([...gaps].sort((a, b) => a - b)[30]!).toBeLessThan(50);

    // …handing uPlot about two points per pixel column instead of 80 000 samples…
    const width = (await plot.locator(".u-over").boundingBox())!.width;
    const dpr = await page.evaluate(() => devicePixelRatio);
    expect(await num("data-points")).toBeLessThanOrEqual(Math.ceil(2 * width * dpr) + 4);

    // …and the sine's peaks survive the reduction
    expect(await num("data-y-span")).toBeGreaterThan(9.5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
