import { devices, expect, test, type APIRequestContext, type Browser, type Page, type TestInfo } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");

interface GameState {
  currentPlayerId: string | null;
  myPlayerId: string;
}

interface Bounds {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

interface ScrollExtent {
  clientHeight: number;
  clientWidth: number;
  scrollHeight: number;
  scrollWidth: number;
}

async function getHostState(page: Page, roomCode: string): Promise<GameState> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`Game state failed with ${response.status}: ${await response.text()}`);
    return response.json() as Promise<GameState>;
  }, `${appUrl}/api/games/${roomCode}`);
}

async function getGuestState(request: APIRequestContext, roomCode: string): Promise<GameState> {
  const response = await request.get(`${appUrl}/api/games/${roomCode}`);
  if (!response.ok()) throw new Error(`Game state failed with ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<GameState>;
}

async function startPhoneGame(browser: Browser, request: APIRequestContext): Promise<{
  context: Awaited<ReturnType<Browser["newContext"]>>;
  page: Page;
}> {
  const { defaultBrowserType: _defaultBrowserType, ...iphone } = devices["iPhone 13"];
  const context = await browser.newContext(iphone);
  const page = await context.newPage();
  const stamp = Date.now().toString(36).slice(-8);

  await page.goto(appUrl);
  await page.getByLabel("Your name").fill(`Phone host ${stamp}`);
  await page.getByRole("radio", { name: /Correspondence/ }).tap();
  await page.locator(".player-count").getByRole("button", { name: "2", exact: true }).tap();
  await page.getByRole("button", { name: "Create table" }).tap();
  await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();

  const roomCode = await page.locator(".invite-code strong").innerText();
  const joinResponse = await request.post(`${appUrl}/api/games/${roomCode}/join`, {
    data: { name: `Phone guest ${stamp}` },
  });
  expect(joinResponse.status()).toBe(201);
  const guest = await getGuestState(request, roomCode);
  await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Shuffle & start" }).tap();
  await expect(page.getByLabel("Game table")).toBeVisible();
  const host = await getHostState(page, roomCode);
  if (host.currentPlayerId !== host.myPlayerId) {
    expect(host.currentPlayerId).toBe(guest.myPlayerId);
    const draw = await request.post(`${appUrl}/api/games/${roomCode}/action`, {
      data: { action: { type: "draw" } },
    });
    expect(draw.ok()).toBe(true);
  }
  await expect(page.getByText("Your turn", { exact: true })).toBeVisible();
  return { context, page };
}

async function readPhoneLayout(page: Page): Promise<{
  actions: Bounds;
  commit: Bounds;
  documentHeight: number;
  documentWidth: number;
  draw: Bounds;
  feltScroll: ScrollExtent;
  header: Bounds;
  players: Bounds;
  rack: Bounds;
  rackScroll: ScrollExtent;
  roomCopy: Bounds;
  shellClientHeight: number;
  shellScrollHeight: number;
  table: Bounds;
  tiles: Bounds[];
  tools: Bounds;
  viewportHeight: number;
  viewportWidth: number;
}> {
  return page.evaluate(() => {
    const bounds = (selector: string): Bounds => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing phone layout element: ${selector}`);
      const { bottom, height, left, right, top, width } = element.getBoundingClientRect();
      return { bottom, height, left, right, top, width };
    };
    const scrollExtent = (selector: string): ScrollExtent => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing phone layout element: ${selector}`);
      const { clientHeight, clientWidth, scrollHeight, scrollWidth } = element;
      return { clientHeight, clientWidth, scrollHeight, scrollWidth };
    };
    const shell = document.querySelector<HTMLElement>(".game-shell");
    if (!shell) throw new Error("Missing game shell");
    return {
      actions: bounds(".rack-action-tools"),
      commit: bounds('.rack-action-tools [aria-label="Commit turn"]'),
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      draw: bounds('.rack-action-tools [aria-label="Draw & end"], .rack-action-tools [aria-label="Pass & end"]'),
      feltScroll: scrollExtent(".sets"),
      header: bounds(".game-header"),
      players: bounds(".players-strip"),
      rack: bounds(".rack-zone"),
      rackScroll: scrollExtent(".rack"),
      roomCopy: bounds(".room-copy-button"),
      shellClientHeight: shell.clientHeight,
      shellScrollHeight: shell.scrollHeight,
      table: bounds(".table-layout"),
      tiles: [...document.querySelectorAll<HTMLElement>(".rack .tile, .set .tile")].map((tile) => {
        const { bottom, height, left, right, top, width } = tile.getBoundingClientRect();
        return { bottom, height, left, right, top, width };
      }),
      tools: bounds(".mobile-tools-toggle"),
      viewportHeight: window.visualViewport?.height ?? window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
}

function expectContained(inner: Bounds, outer: Pick<Bounds, "bottom" | "left" | "right" | "top">, name: string): void {
  expect(inner.left, `${name} should start onscreen`).toBeGreaterThanOrEqual(outer.left - 1);
  expect(inner.right, `${name} should end onscreen`).toBeLessThanOrEqual(outer.right + 1);
  expect(inner.top, `${name} should start onscreen`).toBeGreaterThanOrEqual(outer.top - 1);
  expect(inner.bottom, `${name} should end onscreen`).toBeLessThanOrEqual(outer.bottom + 1);
}

async function expectPlayableViewport(page: Page, minimumTableHeight: number): Promise<void> {
  const layout = await readPhoneLayout(page);
  const viewport = { top: 0, left: 0, right: layout.viewportWidth, bottom: layout.viewportHeight };

  expect(layout.documentWidth).toBeLessThanOrEqual(Math.ceil(layout.viewportWidth));
  expect(layout.documentHeight).toBeLessThanOrEqual(Math.ceil(layout.viewportHeight));
  expect(layout.shellScrollHeight).toBeLessThanOrEqual(layout.shellClientHeight);
  expect(layout.players.top).toBeGreaterThanOrEqual(layout.header.bottom - 1);
  expect(layout.table.top).toBeGreaterThanOrEqual(layout.players.bottom - 1);
  expect(layout.rack.top).toBeGreaterThanOrEqual(layout.table.bottom - 1);
  expect(layout.rack.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
  expect(layout.table.height).toBeGreaterThanOrEqual(minimumTableHeight);
  expect(layout.rackScroll.scrollWidth, "the rack should never scroll sideways")
    .toBeLessThanOrEqual(layout.rackScroll.clientWidth + 1);
  expect(layout.feltScroll.scrollWidth, "the felt should never scroll sideways")
    .toBeLessThanOrEqual(layout.feltScroll.clientWidth + 1);
  expect(layout.feltScroll.scrollHeight, "the felt should never scroll vertically")
    .toBeLessThanOrEqual(layout.feltScroll.clientHeight + 1);
  expect(layout.tiles.length).toBeGreaterThan(0);
  layout.tiles.forEach((tile, index) => expectContained(tile, viewport, `tile ${index + 1}`));
  expectContained(layout.actions, viewport, "turn actions");
  expectContained(layout.draw, viewport, "Draw");
  expectContained(layout.commit, viewport, "Commit");
  expect(layout.draw.height).toBeGreaterThanOrEqual(44);
  expect(layout.commit.height).toBeGreaterThanOrEqual(44);

  const headerControlsOverlap = layout.roomCopy.left < layout.tools.right
    && layout.roomCopy.right > layout.tools.left
    && layout.roomCopy.top < layout.tools.bottom
    && layout.roomCopy.bottom > layout.tools.top;
  expect(headerControlsOverlap, "room copy and the mobile tools menu should not overlap").toBe(false);
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, {
    path,
    contentType: "image/png",
  });
}

test("keeps a full-size staged turn playable through phone rotation", async ({ browser, request }, testInfo) => {
  test.setTimeout(60_000);
  const { context, page } = await startPhoneGame(browser, request);
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await expectPlayableViewport(page, 160);

    const rackTiles = page.locator(".rack .tile");
    const initialRackCount = await rackTiles.count();
    expect(initialRackCount).toBeGreaterThanOrEqual(13);
    await rackTiles.first().tap();
    const newSet = page.getByRole("button", { name: /New set/ });
    await expect(newSet).toBeVisible();
    const [newSetBounds, secondaryBounds] = await Promise.all([
      newSet.boundingBox(),
      page.locator(".rack-secondary-tools").boundingBox(),
    ]);
    expect(newSetBounds).not.toBeNull();
    expect(secondaryBounds).not.toBeNull();
    expect(newSetBounds!.x).toBeGreaterThanOrEqual(secondaryBounds!.x - 1);
    expect(newSetBounds!.x + newSetBounds!.width).toBeLessThanOrEqual(secondaryBounds!.x + secondaryBounds!.width + 1);
    expect(newSetBounds!.height).toBeGreaterThanOrEqual(44);
    await newSet.tap();

    await expect(page.locator(".set")).toHaveCount(1);
    const remainingRackTiles = page.locator(".rack .tile");
    const remainingCount = await remainingRackTiles.count();
    for (let index = 0; index < remainingCount; index += 1) {
      await remainingRackTiles.nth(index).focus();
      await remainingRackTiles.nth(index).press("Space");
    }
    await remainingRackTiles.last().press("Alt+Enter");

    await expect(page.locator(".set")).toHaveCount(2);
    await expect(page.locator(".set .tile")).toHaveCount(initialRackCount);
    await expect.poll(async () => Number(await page.locator(".set-grid").getAttribute("data-felt-scale")))
      .toBeLessThan(1);
    await expectPlayableViewport(page, 160);
    await attachScreenshot(page, testInfo, "phone-portrait");

    for (const viewport of [
      { width: 740, height: 340 },
      { width: 756, height: 308 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.locator(".set .tile")).toHaveCount(initialRackCount);
      await expectPlayableViewport(page, 96);
    }

    const landscapeToolsButton = page.getByRole("button", { name: "Table tools" });
    await landscapeToolsButton.tap();
    const landscapeToolsPanel = page.locator(".mobile-tools-panel");
    await expect(landscapeToolsPanel).toBeVisible();
    const toolsPanelLayout = await landscapeToolsPanel.evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        clientHeight: panel.clientHeight,
        scrollHeight: panel.scrollHeight,
      };
    });
    expect(toolsPanelLayout.bottom).toBeLessThanOrEqual(309);
    expect(toolsPanelLayout.scrollHeight).toBeGreaterThan(toolsPanelLayout.clientHeight);
    const leaveTable = page.getByRole("button", { name: "Leave table" });
    await leaveTable.scrollIntoViewIfNeeded();
    await expect(leaveTable).toBeInViewport();
    expect((await leaveTable.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    const landscapeActivity = page.getByRole("button", { name: "Activity" });
    await landscapeActivity.scrollIntoViewIfNeeded();
    await landscapeActivity.tap();
    await expect(landscapeToolsButton).toBeFocused();
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
    await landscapeToolsButton.tap();
    await page.getByRole("button", { name: "Activity" }).tap();
    await expect(page.getByRole("heading", { name: "Activity" })).toBeHidden();
    await attachScreenshot(page, testInfo, "phone-landscape");

    for (const viewport of [{ width: 430, height: 932 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect(page.locator(".set .tile")).toHaveCount(initialRackCount);
      await expectPlayableViewport(page, 180);
    }

    const toolsButton = page.getByRole("button", { name: "Table tools" });
    await toolsButton.tap();
    await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
    await page.getByRole("button", { name: "Activity" }).tap();
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  } finally {
    await context.close().catch(() => {});
  }
});
