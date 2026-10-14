import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

async function createProject(page: Page, path: string, name: string, template: "virtual-bench" | "empty") {
  await openProjectChooser(page);
  await page.getByRole("tab", { name: "New" }).click();
  await page.getByLabel("Folder (absolute path)").fill(path);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Template").selectOption(template);
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByTestId("project-name")).toHaveText(name);
}

/** Tab titles per group, top-left first. */
async function groups(page: Page): Promise<string[][]> {
  return page.locator(".dv-groupview").evaluateAll((els) =>
    els
      .map((g) => ({ r: g.getBoundingClientRect(), tabs: [...g.querySelectorAll(".dv-tab")].map((t) => (t as HTMLElement).innerText.trim()) }))
      .sort((a, b) => a.r.left - b.r.left || a.r.top - b.r.top)
      .map((g) => g.tabs),
  );
}

test("XY and table Panels in a dockable layout that is saved in the Project", async ({ page }) => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    const bench = join(dir, "bench");
    await createProject(page, bench, "Panel bench", "virtual-bench");
    await page.getByTestId("device-bench").getByRole("button", { name: "Start Virtual Device" }).click();
    await expect(page.getByTestId("device-bench").getByTestId("source-state")).toHaveText("running");
    const workspace = page.getByTestId("workspace");

    // XY Panel: one Signal against another
    await workspace.getByRole("button", { name: "Add XY plot" }).click();
    const xy = page.getByTestId("xy-plot-panel-0");
    await xy.getByLabel("X Signal").selectOption("bench/BENCH_STATE.gyro_x");
    await xy.getByLabel("Y Signal").selectOption("bench/BENCH_STATE.gyro_y");
    await expect.poll(async () => Number(await xy.getByTestId("xy-plot").getAttribute("data-points")), { timeout: 5000 }).toBeGreaterThan(50);

    // table Panel: latest values
    await workspace.getByRole("button", { name: "Add table" }).click();
    const table = page.getByTestId("table-panel-0");
    await table.getByRole("checkbox", { name: "bench/BENCH_STATE.setpoint" }).check();
    const value = table.getByTestId("value-row-bench/BENCH_STATE.setpoint").getByTestId("latest-value");
    await expect(value).toHaveText(/^-?\d/);
    const first = await value.textContent();
    await expect.poll(() => value.textContent()).not.toBe(first);

    // dock: drag the table's tab onto the lower half of the time plot to split it
    expect(await groups(page)).toEqual([["Time plot 1"], ["XY plot 1"], ["Table 1"]]);
    // let saves of the earlier changes land, so the next one counted is the docking's
    const savesNow = () => workspace.getAttribute("data-layout-saves").then(Number);
    let saves = await savesNow();
    for (let settled = false; !settled; ) {
      await page.waitForTimeout(600);
      const n = await savesNow();
      settled = n === saves;
      saves = n;
    }
    const timePanel = page.getByTestId("time-plot-panel-0");
    const box = (await timePanel.boundingBox())!;
    await page.locator(".dv-tab", { hasText: "Table 1" }).dragTo(timePanel, { targetPosition: { x: box.width / 2, y: box.height - 15 } });
    expect(await groups(page)).toEqual([["Time plot 1"], ["Table 1"], ["XY plot 1"]]);
    const below = async () => {
      const [t, b] = [(await timePanel.boundingBox())!, (await table.boundingBox())!];
      return Math.abs(t.x - b.x) < 2 && b.y > t.y + t.height - 2;
    };
    expect(await below()).toBe(true);
    await expect.poll(savesNow).toBeGreaterThan(saves);

    // restored after a reload…
    await page.reload();
    await expect(page.getByTestId("project-name")).toHaveText("Panel bench");
    await expect(table.getByTestId("value-row-bench/BENCH_STATE.setpoint")).toBeVisible();
    await expect.poll(() => groups(page)).toEqual([["Time plot 1"], ["Table 1"], ["XY plot 1"]]);
    expect(await below()).toBe(true);
    await expect(xy.getByLabel("X Signal")).toHaveValue("bench/BENCH_STATE.gyro_x");

    // …and when the Project is opened again; another Project has its own layout
    await createProject(page, join(dir, "other"), "Other", "empty");
    await expect.poll(() => groups(page)).toEqual([["Time plot 1"]]);
    await page.getByRole("button", { name: "Switch Project" }).click();
    await page.getByLabel("Folder (absolute path)").fill(bench);
    await page.getByRole("button", { name: "Open Project" }).click();
    await expect(page.getByTestId("project-name")).toHaveText("Panel bench");
    await expect(xy.getByLabel("Y Signal")).toHaveValue("bench/BENCH_STATE.gyro_y");
    await expect.poll(() => groups(page)).toEqual([["Time plot 1"], ["Table 1"], ["XY plot 1"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable layout file is kept until the user resets it", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    const bench = join(dir, "bench");
    await createProject(page, bench, "Broken layout", "virtual-bench");
    const file = join(bench, "layout.yaml");
    const corrupt = "version: 1\ndock: [unclosed\n";
    await writeFile(file, corrupt);

    // open the Project again: the notice says why, and a default time plot is shown
    await page.getByRole("button", { name: "Switch Project" }).click();
    await page.getByLabel("Folder (absolute path)").fill(bench);
    await page.getByRole("button", { name: "Open Project" }).click();
    const problem = page.getByTestId("layout-problem");
    await expect(problem).toContainText("could not be restored");
    await expect(problem).toContainText("not valid YAML");
    await expect.poll(() => groups(page)).toEqual([["Time plot 1"]]);

    // changing Panels, leaving the view and reloading never write over the file
    await page.getByTestId("workspace").getByRole("button", { name: "Add table" }).click();
    await page.getByRole("tab", { name: "Model Lab" }).click();
    await page.getByRole("tab", { name: "Telemetry" }).click();
    await page.reload();
    await expect(page.getByTestId("layout-problem")).toBeVisible();
    expect(await readFile(file, "utf8")).toBe(corrupt);

    // resetting keeps a backup and saves the Panels shown now
    await page.getByTestId("workspace").getByRole("button", { name: "Add table" }).click();
    await page.getByRole("button", { name: "Reset Layout" }).click();
    await expect(page.getByTestId("layout-backup")).toContainText("layout.yaml.bak");
    await expect(page.getByTestId("layout-problem")).toHaveCount(0);
    expect(await readFile(join(bench, "layout.yaml.bak"), "utf8")).toBe(corrupt);
    await expect.poll(() => readFile(file, "utf8")).toContain("table-1");
    await page.reload();
    await expect.poll(() => groups(page)).toEqual([["Time plot 1"], ["Table 1"]]);
    await expect(page.getByTestId("layout-problem")).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
