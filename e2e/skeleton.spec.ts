import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("connects to the server and creates a Project", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await expect(page.getByTestId("connection-status")).toHaveAttribute("data-state", "connected");

    const path = join(dir, "bench");
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(path);
    await page.getByLabel("Name").fill("E2E bench");
    await page.getByRole("button", { name: "Create Project" }).click();

    await expect(page.getByTestId("current-project")).toContainText("E2E bench");
    expect(await readFile(join(path, "project.yaml"), "utf8")).toContain("E2E bench");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("switches between English and Traditional Chinese and remembers the choice", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Language" }).selectOption("zh-TW");
  await expect(page.getByRole("button", { name: "開啟 Project" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "語言" })).toHaveValue("zh-TW");
  await expect(page.getByRole("heading", { name: "Project" })).toBeVisible();
  await page.getByRole("combobox", { name: "語言" }).selectOption("en");
  await expect(page.getByRole("button", { name: "Open Project" })).toBeVisible();
});
