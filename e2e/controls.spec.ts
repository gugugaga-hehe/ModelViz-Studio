import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

/** --mv-accent in the light theme. */
const ACCENT = "rgb(37, 99, 235)";

const style = (l: Locator) =>
  l.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: `${s.outlineStyle} ${s.outlineColor}`, opacity: s.opacity };
  });

test("buttons and inputs share disabled and keyboard-focus styles", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();

    // keyboard focus on an input and on a button shows the accent ring
    const folder = page.getByLabel("Folder (absolute path)");
    await folder.focus();
    await page.keyboard.press("Tab");
    const name = page.getByLabel("Name");
    await expect(name).toBeFocused();
    expect((await style(name)).outline).toBe(`solid ${ACCENT}`);
    await folder.fill(join(dir, "bench"));
    await name.fill("Controls");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const create = page.getByRole("button", { name: "Create Project" });
    await expect(create).toBeFocused();
    expect((await style(create)).outline).toBe(`solid ${ACCENT}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("project-name")).toHaveText("Controls");

    // a disabled button looks disabled (no Signals selected yet: nothing to pause)
    const pause = page.getByTestId("time-plot-panel-0").getByRole("button", { name: "Pause" });
    await expect(pause).toBeDisabled();
    expect((await style(pause)).opacity).toBe("0.4");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
