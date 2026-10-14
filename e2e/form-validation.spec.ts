import { expect, test } from "@playwright/test";
import { openProjectChooser } from "./helpers.ts";

for (const [lang, labels, button, message] of [
  ["en", ["Folder (absolute path)", "Name"], "Create Project", "This field is required."],
  ["zh-TW", ["資料夾（絕對路徑）", "名稱"], "建立 Project", "此欄位為必填。"],
] as const) {
  test(`validation messages follow the UI language (${lang})`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("combobox", { name: "Language" }).selectOption("en");
    await openProjectChooser(page);
    await page.getByRole("tab", { name: "New" }).click();
    await page.getByRole("combobox", { name: "Language" }).selectOption(lang);
    await page.getByRole("button", { name: button }).click();
    // the first invalid field takes focus, as it would with the browser's own bubble
    await expect(page.getByRole("textbox", { name: labels[0], exact: true })).toBeFocused();

    for (const label of labels) {
      const field = page.getByRole("textbox", { name: label, exact: true });
      await expect(field).toHaveAttribute("aria-invalid", "true");
      const id = await field.getAttribute("aria-describedby");
      await expect(page.locator(`[id="${id}"]`)).toHaveText(message);
    }
    // the message goes away once the field is valid
    const name = page.getByRole("textbox", { name: labels[1], exact: true });
    await name.fill("bench");
    await expect(name).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText(message)).toHaveCount(1);
  });
}
