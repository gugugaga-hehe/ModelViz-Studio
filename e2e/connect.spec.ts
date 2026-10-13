import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

test("connects a Device over TCP and shows the connection state", async ({ page }) => {
  const dir = await mkdtemp(join(tmpdir(), "modelviz-e2e-"));
  try {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByLabel("Folder (absolute path)").fill(join(dir, "bench"));
    await page.getByLabel("Name").fill("Connect bench");
    await page.getByRole("button", { name: "Create Project" }).click();

    const device = page.getByTestId("device-bench");
    await expect(device).toContainText(/Dialect hash: [0-9a-f]{8}/);
    await device.getByRole("button", { name: "Connect…" }).click();
    const form = device.getByRole("form", { name: "Connect to Device" });
    await form.getByLabel("Transport").selectOption("tcp");
    await form.getByRole("textbox", { name: "Host" }).fill("127.0.0.1");
    await form.getByRole("textbox", { name: "Port" }).fill("1"); // nothing listens here
    await form.getByRole("button", { name: "Connect" }).click();

    await expect(device.getByTestId("source-state")).toHaveText(/connecting · TCP/);
    await device.getByRole("button", { name: "Stop" }).click();
    await expect(device.getByTestId("source-state")).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
