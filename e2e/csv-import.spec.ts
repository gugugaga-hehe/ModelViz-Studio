import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("imports a CSV and plays its columns into a time plot", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    const rows = ["t,roll,pitch"];
    for (let i = 0; i <= 300; i++) rows.push(`${(i / 100).toFixed(2)},${Math.sin(i / 20).toFixed(4)},${Math.cos(i / 20).toFixed(4)}`);
    const csv = join(dir, "flight.csv");
    await writeFile(csv, rows.join("\n"));
    const bad = join(dir, "bad.csv");
    await writeFile(bad, "t,roll\n0,1\n0.1,abc\n");

    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "proj"));
    await page.getByLabel("Name").fill("CSV project");
    await page.getByLabel("Template").selectOption("empty");
    await page.getByRole("button", { name: "Create Project" }).click();

    await page.getByRole("button", { name: "Import CSV" }).click();
    const form = page.getByRole("form", { name: "Import CSV" });
    await form.getByLabel("CSV file (absolute path)").fill(bad);
    await form.getByLabel("Name", { exact: true }).fill("bad");
    await form.getByRole("button", { name: "Import" }).click();
    await expect(form.getByRole("alert")).toContainText('line 3, column "roll": "abc" is not a number');

    await form.getByLabel("CSV file (absolute path)").fill(csv);
    await form.getByLabel("Name", { exact: true }).fill("flight");
    await form.getByRole("button", { name: "Import" }).click();
    const rec = page.getByTestId("recording-flight");
    await expect(rec).toContainText("CSV");

    const panel = page.getByTestId("time-plot-panel-0");
    await panel.getByRole("checkbox", { name: "flight/CSV.roll" }).check();
    await panel.getByRole("checkbox", { name: "flight/CSV.pitch" }).check();
    await rec.getByRole("button", { name: "Replay flight" }).click();
    await expect(page.getByTestId("replay-controls")).toBeVisible();
    const plot = panel.getByTestId("time-plot");
    await expect.poll(async () => Number(await plot.getAttribute("data-samples"))).toBeGreaterThan(100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
