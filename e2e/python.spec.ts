import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("sets up the Project's Python environment from the Model Lab", async ({ page }) => {
  test.setTimeout(120000);
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "py"));
    await page.getByLabel("Name").fill("Python project");
    await page.getByLabel("Template").selectOption("empty");
    await page.getByRole("button", { name: "Create Project" }).click();
    await page.getByRole("tab", { name: "Model Lab" }).click();

    const panel = page.getByTestId("python-panel");
    await expect(panel.getByTestId("python-state")).toHaveText("not set up");
    await panel.getByRole("button", { name: "Set up Python environment…" }).click();
    await panel.getByRole("button", { name: "Apply" }).click();
    await expect(panel).toHaveAttribute("data-state", "ready", { timeout: 90000 });
    await expect(panel.getByTestId("python-state")).toHaveText(/ready · 3\.\d+\.\d+/);
    await expect(panel.getByTestId("python-locked")).toHaveText("0 pinned packages");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
