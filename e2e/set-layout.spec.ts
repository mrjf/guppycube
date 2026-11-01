import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const centerTolerancePx = 1;
const edgeTolerancePx = 1;

interface GameState {
  currentPlayerId: string | null;
  myPlayerId: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SetLayout {
  board: Rect;
  grid: Rect;
  scale: number;
  rowCount: number;
  sets: Array<Rect & { row: number; tileIds: string[] }>;
  rows: Array<Array<Rect & { row: number; tileIds: string[] }>>;
  scrolling: {
    bodyHeight: number;
    bodyWidth: number;
    documentHeight: number;
    documentWidth: number;
    gridHeight: number;
    gridScrollHeight: number;
    gridScrollWidth: number;
    gridWidth: number;
    viewportHeight: number;
    viewportWidth: number;
  };
}

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

async function startTwoPlayerGame(page: Page, request: APIRequestContext): Promise<void> {
  const stamp = Date.now().toString(36).slice(-8);
  await page.goto(appUrl);
  await page.getByLabel("Your name").fill(`Set host ${stamp}`);
  await page.locator(".player-count").getByRole("button", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Create table" }).click();
  await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();

  const roomCode = await page.locator(".invite-code strong").innerText();
  const joinResponse = await request.post(`${appUrl}/api/games/${roomCode}/join`, {
    data: { name: `Set guest ${stamp}` },
  });
  expect(joinResponse.status()).toBe(201);
  await expect(joinResponse.json()).resolves.toEqual({ roomCode });
  const guestState = await getApiGameState(request, roomCode);
  await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Shuffle & start" }).click();
  await expect(page.getByLabel("Game table")).toBeVisible();

  const initialState = await getGameState(page, roomCode);
  if (initialState.currentPlayerId !== initialState.myPlayerId) {
    expect(initialState.currentPlayerId).toBe(guestState.myPlayerId);
    const guestDraw = await request.post(`${appUrl}/api/games/${roomCode}/action`, {
      data: { action: { type: "draw" } },
    });
    expect(guestDraw.ok()).toBe(true);
  }
  await expect(page.getByText("Your turn", { exact: true })).toBeVisible();
}

async function addDraftSet(page: Page, tileCount = 1): Promise<string[]> {
  const sets = page.locator(".sets .set");
  const expectedCount = await sets.count() + 1;
  const tileIds = await page.locator(".rack .tile").evaluateAll((tiles, count) =>
    tiles.slice(0, count).map((tile) => (tile as HTMLElement).dataset.tileId ?? ""), tileCount);
  expect(tileIds, `the rack should have ${tileCount} tiles available for the next set`)
    .toHaveLength(tileCount);
  expect(tileIds).not.toContain("");
  for (const tileId of tileIds) {
    const tile = page.locator(`.rack .tile[data-tile-id="${tileId}"]`);
    await tile.focus();
    await tile.press("Space");
  }
  await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(tileCount);
  await page.locator(`.rack .tile[data-tile-id="${tileIds.at(-1)}"]`).press("Alt+Enter");
  await expect(sets).toHaveCount(expectedCount);
  return tileIds;
}

async function readSetLayout(page: Page): Promise<SetLayout> {
  return page.evaluate(() => {
    function rect(selector: string): Rect {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing layout element: ${selector}`);
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }

    const board = document.querySelector<HTMLElement>(".sets");
    const grid = document.querySelector<HTMLElement>(".set-grid");
    if (!board || !grid) throw new Error("Missing the felt or set grid");
    const sets = [...grid.querySelectorAll<HTMLElement>(":scope > .set")].map((set) => {
      const { x, y, width, height } = set.getBoundingClientRect();
      const row = Number.parseInt(set.dataset.feltRow ?? "", 10);
      if (!Number.isInteger(row)) throw new Error("Set is missing its canonical felt row");
      return {
        x,
        y,
        width,
        height,
        row,
        tileIds: [...set.querySelectorAll<HTMLElement>(".tile")].map((tile) => tile.dataset.tileId ?? ""),
      };
    });
    const rowCount = Number.parseInt(grid.dataset.feltRows ?? "", 10);
    const rows = Array.from({ length: rowCount }, (_, index) =>
      sets.filter((set) => set.row === index + 1));
    return {
      board: rect(".sets"),
      grid: rect(".set-grid"),
      scale: Number.parseFloat(grid.dataset.feltScale ?? ""),
      rowCount,
      sets,
      rows,
      scrolling: {
        bodyHeight: document.body.scrollHeight,
        bodyWidth: document.body.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        documentWidth: document.documentElement.scrollWidth,
        gridHeight: grid.clientHeight,
        gridScrollHeight: grid.scrollHeight,
        gridScrollWidth: grid.scrollWidth,
        gridWidth: grid.clientWidth,
        viewportHeight: window.innerHeight,
        viewportWidth: document.documentElement.clientWidth,
      },
    };
  });
}

async function settleFeltLayout(page: Page): Promise<void> {
  let previous = "";
  let stableSamples = 0;
  await expect.poll(async () => {
    const current = JSON.stringify(await page.evaluate(() => {
      const snapshot = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing layout element: ${selector}`);
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const grid = document.querySelector<HTMLElement>(".set-grid");
      if (!grid) throw new Error("Missing the set grid");
      return {
        board: snapshot(".sets"),
        grid: snapshot(".set-grid"),
        pool: snapshot(".pool-count"),
        rows: grid.dataset.feltRows,
        scale: grid.dataset.feltScale,
        sets: [...grid.querySelectorAll<HTMLElement>(":scope > .set")].map((set) => {
          const { x, y, width, height } = set.getBoundingClientRect();
          return { x, y, width, height };
        }),
      };
    }));
    stableSamples = current === previous ? stableSamples + 1 : 0;
    previous = current;
    return stableSamples;
  }, { intervals: [100, 150, 250], timeout: 5_000 }).toBeGreaterThanOrEqual(3);
}

function contentBounds(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function expectCenteredAndContained({ board, grid, sets }: SetLayout, requireCentering = true): void {
  const contents = contentBounds(sets);
  const boardCenterX = board.x + board.width / 2;
  const boardCenterY = board.y + board.height / 2;
  const contentsCenterX = contents.x + contents.width / 2;
  const contentsCenterY = contents.y + contents.height / 2;
  const horizontalTolerance = centerTolerancePx + Math.abs(board.width - grid.width) / 2;
  const verticalTolerance = centerTolerancePx + Math.abs(board.height - grid.height) / 2;

  if (requireCentering) {
    expect(Math.abs(contentsCenterX - boardCenterX), "sets should be horizontally centered on the board")
      .toBeLessThanOrEqual(horizontalTolerance);
    expect(Math.abs(contentsCenterY - boardCenterY), "sets should be vertically centered on the board")
      .toBeLessThanOrEqual(verticalTolerance);
  }

  for (const [index, set] of sets.entries()) {
    expect(set.x, `set ${index + 1} should not overflow the board's left edge`)
      .toBeGreaterThanOrEqual(board.x - edgeTolerancePx);
    expect(set.x + set.width, `set ${index + 1} should not overflow the board's right edge`)
      .toBeLessThanOrEqual(board.x + board.width + edgeTolerancePx);
    expect(set.y, `set ${index + 1} should not overflow the board's top edge`)
      .toBeGreaterThanOrEqual(board.y - edgeTolerancePx);
    expect(set.y + set.height, `set ${index + 1} should not overflow the board's bottom edge`)
      .toBeLessThanOrEqual(board.y + board.height + edgeTolerancePx);
  }
}

function expectRowsCentered(layout: SetLayout, expectedTileCounts: number[][]): void {
  expect(layout.rows.map((row) => row.map((set) => set.tileIds.length))).toEqual(expectedTileCounts);
  const boardCenterX = layout.board.x + layout.board.width / 2;
  const horizontalTolerance = centerTolerancePx + Math.abs(layout.board.width - layout.grid.width) / 2;
  for (const [index, row] of layout.rows.entries()) {
    const rowBounds = contentBounds(row);
    const rowCenterX = rowBounds.x + rowBounds.width / 2;
    expect(Math.abs(rowCenterX - boardCenterX), `row ${index + 1} should be horizontally centered`)
      .toBeLessThanOrEqual(horizontalTolerance);
  }
}

function expectNoScrolling(layout: SetLayout): void {
  expect(layout.scrolling.documentWidth, "the document should not scroll horizontally")
    .toBeLessThanOrEqual(layout.scrolling.viewportWidth);
  expect(layout.scrolling.bodyWidth, "the body should not scroll horizontally")
    .toBeLessThanOrEqual(layout.scrolling.viewportWidth);
  expect(layout.scrolling.documentHeight, "the document should not scroll vertically")
    .toBeLessThanOrEqual(layout.scrolling.viewportHeight);
  expect(layout.scrolling.bodyHeight, "the body should not scroll vertically")
    .toBeLessThanOrEqual(layout.scrolling.viewportHeight);
  expect(layout.scrolling.gridScrollWidth, "the packed felt should not have horizontal overflow")
    .toBeLessThanOrEqual(layout.scrolling.gridWidth + edgeTolerancePx);
  expect(layout.scrolling.gridScrollHeight, "the packed felt should not have vertical overflow")
    .toBeLessThanOrEqual(layout.scrolling.gridHeight + edgeTolerancePx);
}

async function expectTilesClearDrawPile(page: Page): Promise<void> {
  const overlaps = await page.evaluate(() => {
    const drawPile = document.querySelector<HTMLElement>(".pool-count");
    if (!drawPile) throw new Error("Missing draw pile");
    const pile = drawPile.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(".sets .tile")]
      .map((tile) => {
        const rect = tile.getBoundingClientRect();
        return {
          tileId: tile.dataset.tileId ?? "unknown tile",
          overlaps: rect.left < pile.right && rect.right > pile.left
            && rect.top < pile.bottom && rect.bottom > pile.top,
        };
      })
      .filter((tile) => tile.overlaps)
      .map((tile) => tile.tileId);
  });
  expect(overlaps, "draw pile should never cover an actual set tile").toEqual([]);
}

function setSignatures(layout: SetLayout): string[] {
  return layout.sets.map((set) => set.tileIds.join("|"));
}

test("uses stable board order and vertical-first placement across resizes", async ({ page, request }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await startTwoPlayerGame(page, request);

  for (const tileCount of [2, 5, 3, 4]) await addDraftSet(page, tileCount);

  await settleFeltLayout(page);
  const wideLayout = await readSetLayout(page);
  expect(wideLayout.scale).toBe(1);
  expect(wideLayout.rowCount).toBe(4);
  expectRowsCentered(wideLayout, [[2], [5], [3], [4]]);
  expectCenteredAndContained(wideLayout);
  expectNoScrolling(wideLayout);
  const canonicalSignatures = setSignatures(wideLayout);

  await page.reload();
  await expect(page.getByLabel("Game table")).toBeVisible();
  await expect(page.locator(".set-grid")).toHaveAttribute("data-felt-rows", "4");
  await settleFeltLayout(page);
  expect(setSignatures(await readSetLayout(page)), "board display order should survive a reload")
    .toEqual(canonicalSignatures);

  await page.setViewportSize({ width: 520, height: 900 });
  await expect(page.locator(".set-grid")).toHaveAttribute("data-felt-rows", "4");
  await settleFeltLayout(page);
  const packedLayout = await readSetLayout(page);
  expect(packedLayout.scale, "full-size tiles should be retained while four rows fit").toBe(1);
  expect(packedLayout.rowCount).toBe(4);
  expectRowsCentered(packedLayout, [[2], [5], [3], [4]]);
  expectCenteredAndContained(packedLayout);
  expectNoScrolling(packedLayout);
});

test("shrinks a crowded felt on a phone so every set stays visible without scrolling", async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await startTwoPlayerGame(page, request);

  for (let setCount = 0; setCount < 14; setCount += 1) await addDraftSet(page);
  await settleFeltLayout(page);
  const roomyLayout = await readSetLayout(page);
  expect(roomyLayout.sets).toHaveLength(14);
  expect(roomyLayout.scale).toBe(1);
  expectCenteredAndContained(roomyLayout);
  expectNoScrolling(roomyLayout);
  await expectTilesClearDrawPile(page);
  const roomySetWidth = roomyLayout.sets[0]!.width;

  await page.setViewportSize({ width: 360, height: 650 });
  await expect.poll(async () => Number(await page.locator(".set-grid").getAttribute("data-felt-scale")))
    .toBeLessThan(1);
  await settleFeltLayout(page);
  const constrainedLayout = await readSetLayout(page);
  expect(constrainedLayout.sets).toHaveLength(14);
  expect(constrainedLayout.scale, "phone sets should shrink instead of scrolling").toBeLessThan(1);
  expect(constrainedLayout.sets[0]!.width, "phone sets should be smaller than on the desktop felt")
    .toBeLessThan(roomySetWidth);
  expect(constrainedLayout.grid.width, "the felt canvas should stay inside its viewport")
    .toBeLessThanOrEqual(constrainedLayout.board.width + edgeTolerancePx);
  expectCenteredAndContained(constrainedLayout);
  expectNoScrolling(constrainedLayout);
  await expectTilesClearDrawPile(page);

  const feltScroll = await page.locator(".sets").evaluate((felt) => ({
    clientHeight: felt.clientHeight,
    clientWidth: felt.clientWidth,
    scrollHeight: felt.scrollHeight,
    scrollWidth: felt.scrollWidth,
  }));
  expect(feltScroll.scrollWidth).toBeLessThanOrEqual(feltScroll.clientWidth + edgeTolerancePx);
  expect(feltScroll.scrollHeight).toBeLessThanOrEqual(feltScroll.clientHeight + edgeTolerancePx);

  await page.evaluate(() => window.scrollTo({ left: 10_000, top: 10_000 }));
  expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })))
    .toEqual({ x: 0, y: 0 });
});

test("keeps idle set chrome invisible and reveals it without moving the sets", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await startTwoPlayerGame(page, request);
  await addDraftSet(page);
  await addDraftSet(page);
  await settleFeltLayout(page);
  await expect(page.locator(".sets .tile.is-new-activity")).toHaveCount(0);

  const sets = page.locator(".sets .set");
  const set = sets.first();
  const handle = set.locator(":scope > .set-drag-handle");
  await expect(handle).toHaveAccessibleName("Pick up set 1");

  await page.locator(".pool-count").hover();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const restingChrome = await sets.evaluateAll((elements) => {
    const firstSet = elements[0];
    const secondSet = elements[1];
    if (!firstSet || !secondSet) throw new Error("Expected two sets");
    const setStyle = getComputedStyle(firstSet);
    const handleElement = firstSet.querySelector<HTMLElement>(":scope > .set-drag-handle");
    const iconElement = handleElement?.querySelector<SVGElement>("svg");
    if (!handleElement || !iconElement) throw new Error("Set drag handle is missing");
    const handleStyle = getComputedStyle(handleElement);
    const handleBounds = handleElement.getBoundingClientRect();
    const iconBounds = iconElement.getBoundingClientRect();
    const firstBounds = firstSet.getBoundingClientRect();
    const secondBounds = secondSet.getBoundingClientRect();
    const decorationVisible = (selector: string) => {
      const decoration = firstSet.querySelector<HTMLElement>(selector);
      if (!decoration) return false;
      const style = getComputedStyle(decoration);
      const bounds = decoration.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number.parseFloat(style.opacity) > 0
        && bounds.width > 0
        && bounds.height > 0;
    };
    return {
      borderWidths: [
        setStyle.borderTopWidth,
        setStyle.borderRightWidth,
        setStyle.borderBottomWidth,
        setStyle.borderLeftWidth,
      ].map(Number.parseFloat),
      backgroundColor: setStyle.backgroundColor,
      backgroundImage: setStyle.backgroundImage,
      boxShadow: setStyle.boxShadow,
      invalid: firstSet.classList.contains("is-invalid"),
      handleOpacity: Number.parseFloat(handleStyle.opacity),
      handlePointerEvents: handleStyle.pointerEvents,
      handleWidth: handleBounds.width,
      handleHeight: handleBounds.height,
      iconWidth: iconBounds.width,
      iconHeight: iconBounds.height,
      numberVisible: decorationVisible(".set-number"),
      setRects: elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
      tileRects: [...firstSet.querySelectorAll<HTMLElement>(".tile")].map((tile) => {
        const bounds = tile.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
      interSetGap: secondBounds.x - firstBounds.right,
    };
  });
  expect(restingChrome.borderWidths, "a resting set should have no border on any side")
    .toEqual([0, 0, 0, 0]);
  if (restingChrome.invalid) {
    expect(restingChrome.backgroundColor, "an unfinished set should retain its validation signal")
      .not.toBe("rgba(0, 0, 0, 0)");
    expect(restingChrome.boxShadow).not.toBe("none");
  } else {
    expect(restingChrome.backgroundColor, "a valid resting set should have a transparent background")
      .toBe("rgba(0, 0, 0, 0)");
    expect(restingChrome.boxShadow).toBe("none");
  }
  expect(restingChrome.backgroundImage).toBe("none");
  expect(restingChrome.numberVisible, "the set number should never be visible").toBe(false);
  expect(restingChrome.handleOpacity, "the mouse handle should be hidden while the set is idle").toBe(0);
  expect(restingChrome.handlePointerEvents).toBe("none");
  expect(restingChrome.handleWidth).toBeLessThanOrEqual(18);
  expect(restingChrome.handleHeight).toBeLessThanOrEqual(24);
  expect(restingChrome.iconWidth).toBeLessThanOrEqual(12);
  expect(restingChrome.iconHeight).toBeLessThanOrEqual(12);

  await set.hover();
  await expect(handle).toBeVisible();
  await expect(handle).toHaveCSS("opacity", "1");
  await expect(handle).toHaveCSS("pointer-events", "auto");

  const hoveredChrome = await sets.evaluateAll((elements) => {
    const firstSet = elements[0];
    const secondSet = elements[1];
    if (!firstSet || !secondSet) throw new Error("Expected two sets");
    const firstBounds = firstSet.getBoundingClientRect();
    const secondBounds = secondSet.getBoundingClientRect();
    const decorationVisible = (selector: string) => {
      const decoration = firstSet.querySelector<HTMLElement>(selector);
      if (!decoration) return false;
      const style = getComputedStyle(decoration);
      const bounds = decoration.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number.parseFloat(style.opacity) > 0
        && bounds.width > 0
        && bounds.height > 0;
    };
    return {
      backgroundColor: getComputedStyle(firstSet).backgroundColor,
      numberVisible: decorationVisible(".set-number"),
      setRects: elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
      tileRects: [...firstSet.querySelectorAll<HTMLElement>(".tile")].map((tile) => {
        const bounds = tile.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
      interSetGap: secondBounds.x - firstBounds.right,
    };
  });
  expect(hoveredChrome.backgroundColor, "hover should reveal the set background")
    .not.toBe("rgba(0, 0, 0, 0)");
  expect(hoveredChrome.numberVisible, "hover should not restore the removed set number").toBe(false);
  expect(hoveredChrome.setRects, "hover must not change any set's position or size")
    .toEqual(restingChrome.setRects);
  expect(hoveredChrome.tileRects, "hover must not move the tiles within the set")
    .toEqual(restingChrome.tileRects);
  expect(hoveredChrome.interSetGap, "hover must preserve the space between sets")
    .toBe(restingChrome.interSetGap);

  await page.locator(".pool-count").hover();
  await handle.focus();
  await expect(handle).toBeFocused();
  await expect(handle).toBeVisible();
  await expect(handle).toHaveCSS("opacity", "1");
  await expect(handle).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Enter");
  await expect(handle).toHaveAttribute("aria-pressed", "false");
  await expect(set).not.toHaveClass(/\bis-dragging\b/);

  await page.keyboard.press("Space");
  await expect(set.locator('.tile[aria-pressed="true"]')).toHaveCount(await set.locator(".tile").count());
  await expect(set).not.toHaveClass(/\bis-dragging\b/);

  await page.keyboard.press("Escape");
  await expect(set).not.toHaveClass(/\bis-dragging\b/);
  await page.locator(".pool-count").hover();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    const dropTarget = sets.nth(1);
    await set.dispatchEvent("dragstart", { dataTransfer });
    await expect(set).toHaveClass(/\bis-dragging\b/);
    await dropTarget.dispatchEvent("dragover", { dataTransfer });
    await expect(dropTarget).toHaveClass(/\bis-drop-target\b/);
    await expect.poll(() => dropTarget.evaluate((element) => ({
      backgroundColor: getComputedStyle(element).backgroundColor,
      boxShadow: getComputedStyle(element).boxShadow,
    }))).not.toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      boxShadow: "none",
    });
    await set.dispatchEvent("dragend", { dataTransfer });
    await expect(dropTarget).not.toHaveClass(/\bis-drop-target\b/);
  } finally {
    await dataTransfer.dispose();
  }
});
