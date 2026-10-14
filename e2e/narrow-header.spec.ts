import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

/** Heights of the header and of each label in it. */
async function measure(page: Page) {
  const header = page.getByTestId("app-header");
  const items = [page.getByRole("heading", { level: 1 }), page.getByTestId("connection-status"), page.getByTestId("project-name")];
  return {
    header: (await header.boundingBox())!.height,
    items: await Promise.all(items.map(async (l) => (await l.boundingBox())!.height)),
  };
}

test("the header keeps one row on narrow windows in every language", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("A rather long Project name");
    await page.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByTestId("project-name")).toHaveText("A rather long Project name");

    for (const [lang, views] of [
      ["en", ["Telemetry", "Model Lab", "Device Parameters"]],
      ["zh-TW", ["遙測", "Model Lab", "Device Parameter"]],
    ] as const) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByTestId("app-header").getByRole("combobox").selectOption(lang);
      const wide = await measure(page);

      await page.setViewportSize({ width: 600, height: 800 });
      const narrow = await measure(page);
      expect(narrow.header, `${lang}: header height`).toBeCloseTo(wide.header, 0);
      narrow.items.forEach((h, i) => expect(h, `${lang}: label ${i} wraps`).toBeCloseTo(wide.items[i]!, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600);

      // every view stays reachable
      for (const v of views) {
        await page.getByRole("tab", { name: v, exact: true }).click();
        await expect(page.getByRole("tab", { name: v, exact: true })).toHaveAttribute("aria-selected", "true");
      }
      await page.getByRole("tab", { name: views[0], exact: true }).click();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
