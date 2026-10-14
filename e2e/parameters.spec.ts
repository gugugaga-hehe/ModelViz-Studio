import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("lists, reads and writes Device Parameters of a Virtual Device with acknowledgement", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Parameter bench");
    await page.getByLabel("Template").selectOption("virtual-bench");
    await page.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByTestId("project-name")).toHaveText("Parameter bench");

    const view = page.getByTestId("parameters-view");
    await page.getByRole("tab", { name: "Device Parameters" }).click();
    await expect(view.getByRole("button", { name: "Read all from Device" })).toBeDisabled();
    await expect(view).toContainText("Start bench");

    await page.getByRole("tab", { name: "Telemetry" }).click();
    await page.getByTestId("device-bench").getByRole("button", { name: "Start Virtual Device" }).click();
    await expect(page.getByTestId("device-bench").getByTestId("source-state")).toHaveText("running");
    await page.getByRole("tab", { name: "Device Parameters" }).click();
    await view.getByRole("button", { name: "Read all from Device" }).click();
    await expect(view.getByTestId("parameters-table").locator("tbody tr")).toHaveCount(5);

    const ki = view.getByTestId("param-RATE_KI");
    await expect(ki.getByTestId("param-value")).toHaveText("40");
    await ki.getByLabel("New value for RATE_KI").fill("55.5");
    await ki.getByRole("button", { name: "Write" }).click();
    await expect(ki.getByTestId("param-status")).toHaveText("Acknowledged by the Device");
    await expect(ki.getByTestId("param-value")).toHaveText("55.5");

    // outside the Device's range: refused, the old value stays
    const kp = view.getByTestId("param-RATE_KP");
    await kp.getByLabel("New value for RATE_KP").fill("9");
    await kp.getByRole("button", { name: "Write" }).click();
    await expect(kp.getByTestId("param-status")).toHaveAttribute("data-status", "refused");
    await expect(kp.getByTestId("param-status")).toContainText("Device kept 0.8");
    await expect(kp.getByTestId("param-value")).toHaveText("0.8");

    // the UI language switch keeps the glossary term
    await page.getByRole("combobox", { name: "Language" }).selectOption("zh-TW");
    await expect(page.getByRole("tab", { name: "Device Parameter" })).toBeVisible();
    await page.getByRole("combobox", { name: "語言" }).selectOption("en");

    await page.getByRole("tab", { name: "Telemetry" }).click();
    await page.getByTestId("device-bench").getByRole("button", { name: "Stop" }).click();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
