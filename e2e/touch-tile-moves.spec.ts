import { devices, expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");

interface GameState {
  currentPlayerId: string | null;
  myPlayerId: string;
}

async function startPhoneGame(browser: Browser, request: APIRequestContext): Promise<{ context: BrowserContext; page: Page }> {
  const { defaultBrowserType: _defaultBrowserType, ...iphone } = devices["iPhone 13"];
  const context = await browser.newContext(iphone);
  const page = await context.newPage();
  const stamp = Date.now().toString(36).slice(-8);

  await page.goto(appUrl);
  await page.getByLabel("Your name").fill(`Touch host ${stamp}`);
  await page.locator(".player-count").getByRole("button", { name: "2", exact: true }).tap();
  await page.getByRole("button", { name: "Create table" }).tap();
  await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();

  const roomCode = await page.locator(".invite-code strong").innerText();
  const joinResponse = await request.post(`${appUrl}/api/games/${roomCode}/join`, { data: { name: `Touch guest ${stamp}` } });
  expect(joinResponse.status()).toBe(201);
  const guestResponse = await request.get(`${appUrl}/api/games/${roomCode}`);
  const guest = await guestResponse.json() as GameState;
  await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Shuffle & start" }).tap();
  await expect(page.getByLabel("Game table")).toBeVisible();
  const host = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    return response.json() as Promise<GameState>;
  }, `${appUrl}/api/games/${roomCode}`);
  if (host.currentPlayerId !== host.myPlayerId) {
    expect(host.currentPlayerId).toBe(guest.myPlayerId);
    const draw = await request.post(`${appUrl}/api/games/${roomCode}/action`, { data: { action: { type: "draw" } } });
    expect(draw.ok()).toBe(true);
  }
  await expect(page.getByText("Your turn", { exact: true })).toBeVisible();
  return { context, page };
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element has no layout box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function touchInit(point: { x: number; y: number }, pointerId = 7): Record<string, unknown> {
  return { pointerType: "touch", pointerId, isPrimary: true, button: 0, clientX: point.x, clientY: point.y, bubbles: true };
}

async function touchDrag(page: Page, tile: Locator, to: { x: number; y: number }, pointerId = 7): Promise<void> {
  const from = await center(tile);
  await tile.dispatchEvent("pointerdown", touchInit(from, pointerId));
  await tile.dispatchEvent("pointermove", touchInit({ x: from.x + 4, y: from.y - 4 }, pointerId));
  await expect(page.locator(".is-touch-drag-preview")).toHaveCount(0);
  await tile.dispatchEvent("pointermove", touchInit({ x: from.x + 12, y: from.y - 20 }, pointerId));
  await expect(page.locator(".is-touch-drag-preview")).toHaveCount(1);
  await tile.dispatchEvent("pointermove", touchInit(to, pointerId));
  await tile.dispatchEvent("pointerup", touchInit(to, pointerId));
  await expect(page.locator(".is-touch-drag-preview")).toHaveCount(0);
}

test("phone players tap tiles onto a set's handle and drag tiles straight from the rack", async ({ browser, request }) => {
  const { context, page } = await startPhoneGame(browser, request);
  try {
    const rackTiles = page.locator(".rack .tile");
    const rackCount = await rackTiles.count();
    expect(rackCount).toBeGreaterThanOrEqual(4);

    await rackTiles.first().tap();
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(1);
    await page.getByRole("button", { name: /New set/ }).tap();
    const set = page.locator(".sets .set").first();
    await expect(set).toBeVisible();
    await expect(set.locator(".tile")).toHaveCount(1);
    await expect(rackTiles).toHaveCount(rackCount - 1);

    const handle = set.locator(":scope > .set-drag-handle");
    await expect(handle).toHaveAccessibleName("Pick up set 1");

    // Tap to pick up, then tap the set's handle to deposit into that set.
    await rackTiles.first().tap();
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(1);
    await expect(handle).toHaveAccessibleName("Add the selected tile to set 1");
    await handle.tap();
    await expect(set.locator(".tile")).toHaveCount(2);
    await expect(rackTiles).toHaveCount(rackCount - 2);
    await expect(page.locator('.tile[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.locator(".sets .set")).toHaveCount(1);
    await expect(handle).toHaveAccessibleName("Pick up set 1");

    // Drag an unselected rack tile onto the set without tapping it first.
    const draggedId = await rackTiles.first().getAttribute("data-tile-id");
    await touchDrag(page, rackTiles.first(), await center(set));
    await expect(set.locator(".tile")).toHaveCount(3);
    await expect(set.locator(`.tile[data-tile-id="${draggedId}"]`)).toHaveCount(1);
    await expect(rackTiles).toHaveCount(rackCount - 3);
    await expect(page.locator(".sets .set")).toHaveCount(1);

    // Dropping on open felt starts a new set.
    const feltBox = await page.locator(".table-surface").boundingBox();
    if (!feltBox) throw new Error("Missing table surface");
    await touchDrag(page, rackTiles.first(), { x: feltBox.x + feltBox.width - 30, y: feltBox.y + feltBox.height - 24 });
    await expect(page.locator(".sets .set")).toHaveCount(2);
    await expect(rackTiles).toHaveCount(rackCount - 4);

    // Dropping outside any target cancels and leaves everything in place.
    const headerPoint = await center(page.locator(".game-header"));
    await touchDrag(page, rackTiles.first(), headerPoint);
    await expect(rackTiles).toHaveCount(rackCount - 4);
    await expect(page.locator(".sets .set")).toHaveCount(2);
    await expect(page.locator('.tile[aria-pressed="true"]')).toHaveCount(0);

    // A plain tap on a tile after a drag still toggles selection.
    await rackTiles.first().tap();
    await expect(rackTiles.first()).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(600); // keep the second tap from registering as a double-tap
    await rackTiles.first().tap();
    await expect(rackTiles.first()).toHaveAttribute("aria-pressed", "false");

    // Felt tiles drag back to the rack too.
    const feltTile = set.locator(".tile").last();
    const emptySlot = page.locator(".rack .rack-slot.is-empty").first();
    await touchDrag(page, feltTile, await center(emptySlot));
    await expect(set.locator(".tile")).toHaveCount(2);
    await expect(rackTiles).toHaveCount(rackCount - 3);
  } finally {
    await context.close();
  }
});
