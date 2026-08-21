import { expect, test, type Locator, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");

interface HighlightGeometry {
  decoratedBottom: number;
  decoratedTop: number;
  lowerClipEdge: number;
  outlineStyle: string;
  outlineWidth: number;
  upperClipEdge: number;
}

async function highlightGeometry(tile: Locator): Promise<HighlightGeometry> {
  return tile.evaluate((element) => {
    const tileBox = element.getBoundingClientRect();
    const tileStyle = getComputedStyle(element);
    const outlineWidth = Number.parseFloat(tileStyle.outlineWidth) || 0;
    const outlineOffset = Number.parseFloat(tileStyle.outlineOffset) || 0;
    const outlineExtent = Math.max(0, outlineWidth + outlineOffset);
    const clippingAncestors: DOMRect[] = [];

    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (["auto", "clip", "hidden", "scroll"].includes(style.overflowY)) {
        clippingAncestors.push(ancestor.getBoundingClientRect());
      }
    }

    return {
      decoratedBottom: tileBox.bottom + outlineExtent,
      decoratedTop: tileBox.top - outlineExtent,
      lowerClipEdge: Math.min(window.innerHeight, ...clippingAncestors.map((box) => box.bottom)),
      outlineStyle: tileStyle.outlineStyle,
      outlineWidth,
      upperClipEdge: Math.max(0, ...clippingAncestors.map((box) => box.top)),
    };
  });
}

async function expectVerticalHighlightVisible(tile: Locator, state: string): Promise<void> {
  const geometry = await highlightGeometry(tile);
  expect(geometry.outlineStyle, `${state} tile should render an outline`).not.toBe("none");
  expect(geometry.outlineWidth, `${state} tile should render a visible outline`).toBeGreaterThan(0);
  expect(
    geometry.decoratedTop,
    `${state} highlight top ${geometry.decoratedTop}px crossed clipping edge ${geometry.upperClipEdge}px`,
  ).toBeGreaterThanOrEqual(geometry.upperClipEdge - 0.5);
  expect(
    geometry.decoratedBottom,
    `${state} highlight bottom ${geometry.decoratedBottom}px crossed clipping edge ${geometry.lowerClipEdge}px`,
  ).toBeLessThanOrEqual(geometry.lowerClipEdge + 0.5);
}

async function startTwoPlayerComputerGame(page: Page): Promise<void> {
  await page.goto(appUrl);
  await page.getByLabel("Your name").fill(`Highlight ${Date.now().toString(36).slice(-7)}`);
  await page.locator(".player-count").getByRole("button", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Create table" }).click();
  await page.getByRole("button", { name: "Add computer" }).click();
  await page.getByRole("button", { name: "Shuffle & start" }).click();
  await expect(page.getByLabel("Game table")).toBeVisible();
  await expect(page.getByText("Your turn", { exact: true })).toBeVisible({ timeout: 10_000 });
}

test("keeps the top-row selected and focused highlights visible in the compact-height rack", async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 958, height: 558 });
  await startTwoPlayerComputerGame(page);

  expect(await page.evaluate(() => window.matchMedia("(max-height: 820px)").matches)).toBe(true);
  const topRow = page.locator('.rack-level[data-rack-row="1"]');
  const topTile = topRow.locator(".tile").first();
  await expect(topRow).toBeVisible();
  await expect(topTile).toBeEnabled();

  await topTile.focus();
  await page.keyboard.press("Space");
  await expect(topTile).toBeFocused();
  await expect(topTile).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(150);
  await expectVerticalHighlightVisible(topTile, "selected and focused top-row");

  await page.keyboard.press("Escape");
  await expect(topTile).toBeFocused();
  await expect(topTile).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(150);
  await expectVerticalHighlightVisible(topTile, "focused top-row");
});
