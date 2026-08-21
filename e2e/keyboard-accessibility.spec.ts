import { expect, test } from "@playwright/test";

test("supports arrow-key tabs and keeps focus inside the rules dialog", async ({ page }) => {
  await page.goto("/");

  const createTab = page.getByRole("tab", { name: "New table" });
  const joinTab = page.getByRole("tab", { name: "Join a table" });
  await createTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(joinTab).toBeFocused();
  await expect(joinTab).toHaveAttribute("aria-selected", "true");
  await expect(createTab).toHaveAttribute("tabindex", "-1");

  await page.keyboard.press("Home");
  await expect(createTab).toBeFocused();
  await expect(createTab).toHaveAttribute("aria-selected", "true");

  const helpButton = page.getByRole("button", { name: "How to play" });
  await helpButton.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Make the table work." });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("heading", { name: "Make the table work." })).toBeFocused();
  await expect(dialog.getByRole("heading", { name: "Play without the mouse." })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(helpButton).toBeFocused();
});
