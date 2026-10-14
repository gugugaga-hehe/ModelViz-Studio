import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("Push shows the differences and writes nothing until confirmed", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Push bench");
    await page.getByLabel("Template").selectOption("virtual-bench");
    await page.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByTestId("project-name")).toHaveText("Push bench");
    await page.getByTestId("device-bench").getByRole("button", { name: "Start Virtual Device" }).click();
    await expect(page.getByTestId("device-bench").getByTestId("source-state")).toHaveText("running");

    await page.getByRole("tab", { name: "Device Parameters" }).click();
    const view = page.getByTestId("parameters-view");
    // the example Project maps the rate loop's Kp, Ki and sensor fc
    await expect(page.getByTestId("mappings-table").locator("tbody tr")).toHaveCount(3);

    // make the Device differ from the Block Parameter (Ki = 40)
    await view.getByRole("button", { name: "Read all from Device" }).click();
    const ki = view.getByTestId("param-RATE_KI");
    await ki.getByLabel("New value for RATE_KI").fill("55");
    await ki.getByRole("button", { name: "Write" }).click();
    await expect(ki.getByTestId("param-value")).toHaveText("55");

    // review, then cancel: nothing is written
    await page.getByRole("button", { name: "Push…" }).click();
    const dialog = page.getByRole("dialog", { name: "Review Push to bench" });
    await expect(dialog.getByTestId("push-row-RATE_KI").getByTestId("push-status")).toHaveAttribute("data-status", "changed");
    await expect(dialog.getByTestId("push-row-RATE_KI")).toContainText("55");
    await expect(dialog.getByTestId("push-row-RATE_KP").getByTestId("push-status")).toHaveAttribute("data-status", "unchanged");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await ki.getByRole("button", { name: "Read" }).click();
    await expect(ki.getByTestId("param-status")).toHaveText("Read from the Device");
    await expect(ki.getByTestId("param-value")).toHaveText("55");

    // review again and confirm: written and acknowledged per Device Parameter
    await page.getByRole("button", { name: "Push…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Write 1 change to Device" }).click();
    const results = page.getByRole("dialog", { name: "Push to bench: results" });
    await expect(results.getByTestId("push-row-RATE_KI").getByTestId("push-outcome")).toHaveAttribute("data-outcome", "acknowledged");
    await expect(results.getByTestId("push-row-RATE_KP").getByTestId("push-outcome")).toHaveAttribute("data-outcome", "not_written");
    await results.getByRole("button", { name: "Close" }).click();
    await expect(ki.getByTestId("param-value")).toHaveText("40");

    await page.getByRole("tab", { name: "Telemetry" }).click();
    await page.getByTestId("device-bench").getByRole("button", { name: "Stop" }).click();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
