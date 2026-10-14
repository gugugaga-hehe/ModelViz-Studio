import { expect, type Page } from "@playwright/test";

/**
 * The server is shared by all e2e tests, so a Project may already be open.
 * Brings the UI to the Project chooser either way (expects English UI).
 */
export async function openProjectChooser(page: Page): Promise<void> {
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-state", "connected");
  const switcher = page.getByRole("button", { name: "Switch Project" });
  if (await page.getByTestId("project-name").isVisible()) await switcher.click();
  await expect(page.getByRole("tab", { name: "New" })).toBeVisible();
}
