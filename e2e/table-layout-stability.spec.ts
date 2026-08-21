import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const maxLayoutShiftPx = 0.5;

interface GameState {
  currentPlayerId: string | null;
  myPlayerId: string;
  myRack: string[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type LayoutSnapshot = Record<"tableSurface" | "tableTopline" | "poolCount" | "board", Rect>;
type LayoutShift = Record<keyof LayoutSnapshot, Rect>;

async function getGameState(page: Page, roomCode: string): Promise<GameState> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`Game state failed with ${response.status}: ${await response.text()}`);
    return response.json() as Promise<GameState>;
  }, `${appUrl}/api/games/${roomCode}`);
}

async function getApiGameState(request: APIRequestContext, roomCode: string): Promise<GameState> {
  const response = await request.get(`${appUrl}/api/games/${roomCode}`);
  if (!response.ok()) throw new Error(`Game state failed with ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<GameState>;
}

async function readLayout(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const selectors = {
      tableSurface: ".table-surface",
      tableTopline: ".table-topline",
      poolCount: ".pool-count",
      board: ".melds",
    } as const;

    return Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing layout landmark: ${selector}`);
      const { x, y, width, height } = element.getBoundingClientRect();
      return [name, { x, y, width, height }];
    })) as LayoutSnapshot;
  });
}

function layoutShift(before: LayoutSnapshot, after: LayoutSnapshot): LayoutShift {
  return Object.fromEntries(Object.keys(before).map((name) => {
    const key = name as keyof LayoutSnapshot;
    return [key, {
      x: after[key].x - before[key].x,
      y: after[key].y - before[key].y,
      width: after[key].width - before[key].width,
      height: after[key].height - before[key].height,
    }];
  })) as LayoutShift;
}

async function expectGameToFitViewport(page: Page): Promise<void> {
  const fit = await page.evaluate(() => {
    const game = document.querySelector(".game-shell")?.getBoundingClientRect();
    const table = document.querySelector(".table-layout")?.getBoundingClientRect();
    const rack = document.querySelector(".rack-zone")?.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight,
      game: game && { top: game.top, bottom: game.bottom, height: game.height },
      table: table && { top: table.top, bottom: table.bottom, height: table.height },
      rack: rack && { top: rack.top, bottom: rack.bottom, height: rack.height },
    };
  });

  expect(fit.documentHeight).toBeLessThanOrEqual(fit.viewportHeight);
  expect(fit.bodyHeight).toBeLessThanOrEqual(fit.viewportHeight);
  expect(fit.game?.top).toBe(0);
  expect(fit.game?.bottom).toBeLessThanOrEqual(fit.viewportHeight);
  expect(fit.table?.height).toBeGreaterThan(120);
  expect(fit.rack?.top).toBeGreaterThanOrEqual(fit.table?.bottom ?? 0);
  expect(fit.rack?.bottom).toBeLessThanOrEqual(fit.viewportHeight);
}

test("keeps only play content and the compact draw pile on the felt", async ({ page, request }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const stamp = Date.now().toString(36).slice(-8);
  const hostName = `Layout host ${stamp}`;
  const guestName = `Guest ${stamp}`;

  await page.goto(appUrl);
  await page.getByLabel("Your name").fill(hostName);
  await page.locator(".player-count").getByRole("button", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Create table" }).click();
  await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();
  const roomCode = await page.locator(".invite-code strong").innerText();

  const joinResponse = await request.post(`${appUrl}/api/games/${roomCode}/join`, {
    data: { name: guestName },
  });
  expect(joinResponse.status()).toBe(201);
  await expect(joinResponse.json()).resolves.toEqual({ roomCode });
  const guestState = await getApiGameState(request, roomCode);
  await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Shuffle & start" }).click();
  await expect(page.getByLabel("Game table")).toBeVisible();
  const playerCards = page.locator(".players-strip .player-card");
  const localPlayerCard = playerCards.filter({ hasText: hostName });
  const guestPlayerCard = playerCards.filter({ hasText: guestName });
  await expect(playerCards).toHaveCount(2);
  await expect(localPlayerCard).toHaveClass(/\bis-me\b/);
  await expect(localPlayerCard.locator(".you-badge")).toHaveText("You");

  const initialState = await getGameState(page, roomCode);
  if (initialState.currentPlayerId !== initialState.myPlayerId) {
    expect(initialState.currentPlayerId).toBe(guestState.myPlayerId);
    const guestDraw = await request.post(`${appUrl}/api/games/${roomCode}/action`, {
      data: { action: { type: "draw" } },
    });
    expect(guestDraw.ok()).toBe(true);
  }
  await expect(page.getByText("Your turn", { exact: true })).toBeVisible();
  await expect(localPlayerCard).toHaveClass(/\bis-turn\b/);
  await expect(localPlayerCard).toHaveAttribute("aria-current", "true");
  await expect(localPlayerCard.locator(".player-status")).toHaveText("On the clock");
  await expect(guestPlayerCard).not.toHaveClass(/\bis-turn\b/);
  const tableSurface = page.locator(".table-surface");
  await expect(tableSurface.locator(":scope > *")).toHaveCount(2);
  await expect(tableSurface.locator(":scope > .pool-count")).toHaveCount(1);
  await expect(tableSurface.locator(":scope > .melds")).toHaveCount(1);
  await expect(tableSurface.locator("h1, h2, h3, p, .table-summary, .table-drop-instruction, .table-turn-tools"))
    .toHaveCount(0);
  await expect(tableSurface.locator("button")).toHaveCount(1);

  const drawPileButton = tableSurface.getByRole("button", { name: /Draw one tile and end turn/ });
  await expect(drawPileButton).toBeVisible();
  await expect(drawPileButton).toBeEnabled();
  await expect(drawPileButton.locator(".tile-stack-icon")).toBeVisible();
  const drawPileBox = await drawPileButton.boundingBox();
  expect(drawPileBox).not.toBeNull();
  expect(drawPileBox!.width, "the simulated draw pile should remain compact").toBeLessThanOrEqual(150);
  expect(drawPileBox!.height, "the simulated draw pile should remain compact").toBeLessThanOrEqual(60);

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 1280, height: 720 },
    { width: 390, height: 760 },
    { width: 390, height: 667 },
  ]) {
    await page.setViewportSize(viewport);
    await expectGameToFitViewport(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  const beforeState = await getGameState(page, roomCode);
  expect(beforeState.currentPlayerId).toBe(beforeState.myPlayerId);
  const poolBefore = Number(await page.locator(".pool-count strong").innerText());
  const before = await readLayout(page);

  await drawPileButton.click();
  await expect(page.getByText(`${guestName}'s turn`, { exact: true })).toBeVisible();
  await expect(localPlayerCard).not.toHaveClass(/\bis-turn\b/);
  await expect(localPlayerCard).not.toHaveAttribute("aria-current", "true");
  await expect(guestPlayerCard).toHaveClass(/\bis-turn\b/);
  await expect(guestPlayerCard).toHaveAttribute("aria-current", "true");
  await expect(guestPlayerCard.locator(".player-status")).toHaveText("On the clock");
  await expect(drawPileButton).toHaveCount(1);
  await expect(drawPileButton).toBeDisabled();

  const afterState = await getGameState(page, roomCode);
  expect(afterState.currentPlayerId).toBe(guestState.myPlayerId);
  expect(afterState.myRack).toHaveLength(beforeState.myRack.length + 1);
  await expect(page.locator(".pool-count strong")).toHaveText(String(poolBefore - 1));
  const after = await readLayout(page);
  const shifts = layoutShift(before, after);
  console.log(`TABLE_LAYOUT_MEASUREMENTS ${JSON.stringify({ before, after, shifts })}`);

  for (const [landmark, shift] of Object.entries(shifts)) {
    for (const [dimension, pixels] of Object.entries(shift)) {
      expect(Math.abs(pixels), `${landmark}.${dimension} shifted by ${pixels}px`).toBeLessThanOrEqual(maxLayoutShiftPx);
    }
  }
});
