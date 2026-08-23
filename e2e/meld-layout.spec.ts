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

interface MeldLayout {
  board: Rect;
  grid: Rect;
  scale: number;
  rowCount: number;
  melds: Array<Rect & { row: number; tileIds: string[] }>;
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
  await page.getByLabel("Your name").fill(`Meld host ${stamp}`);
  await page.locator(".player-count").getByRole("button", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Create table" }).click();
  await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();

  const roomCode = await page.locator(".invite-code strong").innerText();
  const joinResponse = await request.post(`${appUrl}/api/games/${roomCode}/join`, {
    data: { name: `Meld guest ${stamp}` },
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

async function addDraftMeld(page: Page, tileCount = 1): Promise<string[]> {
  const melds = page.locator(".melds .meld");
  const expectedCount = await melds.count() + 1;
  const tileIds = await page.locator(".rack .tile").evaluateAll((tiles, count) =>
    tiles.slice(0, count).map((tile) => (tile as HTMLElement).dataset.tileId ?? ""), tileCount);
  expect(tileIds, `the rack should have ${tileCount} tiles available for the next meld`)
    .toHaveLength(tileCount);
  expect(tileIds).not.toContain("");
  for (const tileId of tileIds) {
    const tile = page.locator(`.rack .tile[data-tile-id="${tileId}"]`);
    await tile.focus();
    await tile.press("Space");
  }
  await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(tileCount);
  await page.locator(`.rack .tile[data-tile-id="${tileIds.at(-1)}"]`).press("Alt+Enter");
  await expect(melds).toHaveCount(expectedCount);
  return tileIds;
}

async function readMeldLayout(page: Page): Promise<MeldLayout> {
  return page.evaluate(() => {
    function rect(selector: string): Rect {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing layout element: ${selector}`);
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }

    const board = document.querySelector<HTMLElement>(".melds");
    const grid = document.querySelector<HTMLElement>(".meld-grid");
    if (!board || !grid) throw new Error("Missing the felt or meld grid");
    const melds = [...grid.querySelectorAll<HTMLElement>(":scope > .meld")].map((meld) => {
      const { x, y, width, height } = meld.getBoundingClientRect();
      const row = Number.parseInt(meld.dataset.feltRow ?? "", 10);
      if (!Number.isInteger(row)) throw new Error("Meld is missing its canonical felt row");
      return {
        x,
        y,
        width,
        height,
        row,
        tileIds: [...meld.querySelectorAll<HTMLElement>(".tile")].map((tile) => tile.dataset.tileId ?? ""),
      };
    });
    const rowCount = Number.parseInt(grid.dataset.feltRows ?? "", 10);
    const rows = Array.from({ length: rowCount }, (_, index) =>
      melds.filter((meld) => meld.row === index + 1));
    return {
      board: rect(".melds"),
      grid: rect(".meld-grid"),
      scale: Number.parseFloat(grid.dataset.feltScale ?? ""),
      rowCount,
      melds,
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
  await expect.poll(async () => {
    const current = JSON.stringify(await page.locator(".meld-grid > .meld").evaluateAll((melds) =>
      melds.map((meld) => {
        const { x, y, width, height } = meld.getBoundingClientRect();
        return { x, y, width, height };
      })));
    const stable = current === previous;
    previous = current;
    return stable;
  }, { intervals: [100, 100, 100, 100, 100] }).toBe(true);
}

function contentBounds(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function expectCenteredAndContained({ board, grid, melds }: MeldLayout, requireCentering = true): void {
  const contents = contentBounds(melds);
  const boardCenterX = board.x + board.width / 2;
  const boardCenterY = board.y + board.height / 2;
  const contentsCenterX = contents.x + contents.width / 2;
  const contentsCenterY = contents.y + contents.height / 2;
  const horizontalTolerance = centerTolerancePx + Math.abs(board.width - grid.width) / 2;
  const verticalTolerance = centerTolerancePx + Math.abs(board.height - grid.height) / 2;

  if (requireCentering) {
    expect(Math.abs(contentsCenterX - boardCenterX), "melds should be horizontally centered on the board")
      .toBeLessThanOrEqual(horizontalTolerance);
    expect(Math.abs(contentsCenterY - boardCenterY), "melds should be vertically centered on the board")
      .toBeLessThanOrEqual(verticalTolerance);
  }

  for (const [index, meld] of melds.entries()) {
    expect(meld.x, `meld ${index + 1} should not overflow the board's left edge`)
      .toBeGreaterThanOrEqual(board.x - edgeTolerancePx);
    expect(meld.x + meld.width, `meld ${index + 1} should not overflow the board's right edge`)
      .toBeLessThanOrEqual(board.x + board.width + edgeTolerancePx);
    expect(meld.y, `meld ${index + 1} should not overflow the board's top edge`)
      .toBeGreaterThanOrEqual(board.y - edgeTolerancePx);
    expect(meld.y + meld.height, `meld ${index + 1} should not overflow the board's bottom edge`)
      .toBeLessThanOrEqual(board.y + board.height + edgeTolerancePx);
  }
}

function expectRowsCentered(layout: MeldLayout, expectedTileCounts: number[][]): void {
  expect(layout.rows.map((row) => row.map((meld) => meld.tileIds.length))).toEqual(expectedTileCounts);
  const boardCenterX = layout.board.x + layout.board.width / 2;
  const horizontalTolerance = centerTolerancePx + Math.abs(layout.board.width - layout.grid.width) / 2;
  for (const [index, row] of layout.rows.entries()) {
    const rowBounds = contentBounds(row);
    const rowCenterX = rowBounds.x + rowBounds.width / 2;
    expect(Math.abs(rowCenterX - boardCenterX), `row ${index + 1} should be horizontally centered`)
      .toBeLessThanOrEqual(horizontalTolerance);
  }
}

function expectNoScrolling(layout: MeldLayout): void {
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
    return [...document.querySelectorAll<HTMLElement>(".melds .tile")]
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
  expect(overlaps, "draw pile should never cover an actual meld tile").toEqual([]);
}

function meldSignatures(layout: MeldLayout): string[] {
  return layout.melds.map((meld) => meld.tileIds.join("|"));
}

test("uses a stable canonical order and best-fits complementary meld widths into fewer rows", async ({ page, request }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await startTwoPlayerGame(page, request);

  for (const tileCount of [2, 5, 3, 4]) await addDraftMeld(page, tileCount);

  await settleFeltLayout(page);
  const wideLayout = await readMeldLayout(page);
  expect(wideLayout.scale).toBe(1);
  expect(wideLayout.rowCount).toBe(1);
  expectRowsCentered(wideLayout, [[5, 4, 3, 2]]);
  expectCenteredAndContained(wideLayout);
  expectNoScrolling(wideLayout);
  const canonicalSignatures = meldSignatures(wideLayout);

  await page.reload();
  await expect(page.getByLabel("Game table")).toBeVisible();
  await expect(page.locator(".meld-grid")).toHaveAttribute("data-felt-rows", "1");
  await settleFeltLayout(page);
  expect(meldSignatures(await readMeldLayout(page)), "canonical display order should survive a reload")
    .toEqual(canonicalSignatures);

  await page.setViewportSize({ width: 520, height: 900 });
  await expect(page.locator(".meld-grid")).toHaveAttribute("data-felt-rows", "2");
  await settleFeltLayout(page);
  const packedLayout = await readMeldLayout(page);
  expect(packedLayout.scale, "full-size tiles should be retained while two rows fit").toBe(1);
  expectRowsCentered(packedLayout, [[5, 2], [4, 3]]);
  expectCenteredAndContained(packedLayout);
  expectNoScrolling(packedLayout);
});

test("shrinks a worst-case-like draft to prevent board or document scrolling", async ({ page, request }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await startTwoPlayerGame(page, request);

  for (let meldCount = 0; meldCount < 14; meldCount += 1) await addDraftMeld(page);
  await settleFeltLayout(page);
  const roomyLayout = await readMeldLayout(page);
  expect(roomyLayout.melds).toHaveLength(14);
  expect(roomyLayout.scale).toBe(1);
  expectCenteredAndContained(roomyLayout);
  expectNoScrolling(roomyLayout);
  await expectTilesClearDrawPile(page);
  const roomyTileWidth = roomyLayout.melds[0]!.width;

  await page.setViewportSize({ width: 360, height: 650 });
  await expect.poll(async () => Number(await page.locator(".meld-grid").getAttribute("data-felt-scale")))
    .toBeLessThan(1);
  await settleFeltLayout(page);
  const constrainedLayout = await readMeldLayout(page);
  expect(constrainedLayout.melds).toHaveLength(14);
  expect(constrainedLayout.scale, "the engine should reduce tile scale before introducing scrolling")
    .toBeLessThan(1);
  expect(constrainedLayout.melds[0]!.width, "rendered melds should actually shrink with the scale")
    .toBeLessThan(roomyTileWidth);
  expect(constrainedLayout.rowCount, "the constrained layout should still avoid excessive rows")
    .toBeLessThanOrEqual(4);
  expectCenteredAndContained(constrainedLayout, false);
  expectNoScrolling(constrainedLayout);
  await expectTilesClearDrawPile(page);

  await page.evaluate(() => window.scrollTo({ left: 10_000, top: 10_000 }));
  expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })))
    .toEqual({ x: 0, y: 0 });
});

test("keeps idle meld chrome invisible and reveals it without moving the melds", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await startTwoPlayerGame(page, request);
  await addDraftMeld(page);
  await addDraftMeld(page);
  await settleFeltLayout(page);
  await expect(page.locator(".melds .tile.is-new-activity")).toHaveCount(0);

  const melds = page.locator(".melds .meld");
  const meld = melds.first();
  const handle = meld.locator(":scope > .meld-drag-handle");
  await expect(handle).toHaveAccessibleName("Pick up meld 1");

  await page.locator(".table-topline").hover();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const restingChrome = await melds.evaluateAll((elements) => {
    const firstMeld = elements[0];
    const secondMeld = elements[1];
    if (!firstMeld || !secondMeld) throw new Error("Expected two melds");
    const meldStyle = getComputedStyle(firstMeld);
    const handleElement = firstMeld.querySelector<HTMLElement>(":scope > .meld-drag-handle");
    const iconElement = handleElement?.querySelector<SVGElement>("svg");
    if (!handleElement || !iconElement) throw new Error("Meld drag handle is missing");
    const handleStyle = getComputedStyle(handleElement);
    const handleBounds = handleElement.getBoundingClientRect();
    const iconBounds = iconElement.getBoundingClientRect();
    const firstBounds = firstMeld.getBoundingClientRect();
    const secondBounds = secondMeld.getBoundingClientRect();
    const decorationVisible = (selector: string) => {
      const decoration = firstMeld.querySelector<HTMLElement>(selector);
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
        meldStyle.borderTopWidth,
        meldStyle.borderRightWidth,
        meldStyle.borderBottomWidth,
        meldStyle.borderLeftWidth,
      ].map(Number.parseFloat),
      backgroundColor: meldStyle.backgroundColor,
      backgroundImage: meldStyle.backgroundImage,
      boxShadow: meldStyle.boxShadow,
      invalid: firstMeld.classList.contains("is-invalid"),
      handleOpacity: Number.parseFloat(handleStyle.opacity),
      handlePointerEvents: handleStyle.pointerEvents,
      handleWidth: handleBounds.width,
      handleHeight: handleBounds.height,
      iconWidth: iconBounds.width,
      iconHeight: iconBounds.height,
      numberVisible: decorationVisible(".meld-number"),
      statusVisible: decorationVisible(".meld-status"),
      meldRects: elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
      tileRects: [...firstMeld.querySelectorAll<HTMLElement>(".tile")].map((tile) => {
        const bounds = tile.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
      interMeldGap: secondBounds.x - firstBounds.right,
    };
  });
  expect(restingChrome.borderWidths, "a resting meld should have no border on any side")
    .toEqual([0, 0, 0, 0]);
  if (restingChrome.invalid) {
    expect(restingChrome.backgroundColor, "an unfinished meld should retain its validation signal")
      .not.toBe("rgba(0, 0, 0, 0)");
    expect(restingChrome.boxShadow).not.toBe("none");
  } else {
    expect(restingChrome.backgroundColor, "a valid resting meld should have a transparent background")
      .toBe("rgba(0, 0, 0, 0)");
    expect(restingChrome.boxShadow).toBe("none");
  }
  expect(restingChrome.backgroundImage).toBe("none");
  expect(restingChrome.numberVisible, "the meld number should never be visible").toBe(false);
  expect(restingChrome.statusVisible, "only unfinished melds should expose a resting validation status")
    .toBe(restingChrome.invalid);
  expect(restingChrome.handleOpacity, "the mouse handle should be hidden while the meld is idle").toBe(0);
  expect(restingChrome.handlePointerEvents).toBe("none");
  expect(restingChrome.handleWidth).toBeLessThanOrEqual(18);
  expect(restingChrome.handleHeight).toBeLessThanOrEqual(24);
  expect(restingChrome.iconWidth).toBeLessThanOrEqual(12);
  expect(restingChrome.iconHeight).toBeLessThanOrEqual(12);

  await meld.hover();
  await expect(handle).toBeVisible();
  await expect(handle).toHaveCSS("opacity", "1");
  await expect(handle).toHaveCSS("pointer-events", "auto");

  const hoveredChrome = await melds.evaluateAll((elements) => {
    const firstMeld = elements[0];
    const secondMeld = elements[1];
    if (!firstMeld || !secondMeld) throw new Error("Expected two melds");
    const firstBounds = firstMeld.getBoundingClientRect();
    const secondBounds = secondMeld.getBoundingClientRect();
    const decorationVisible = (selector: string) => {
      const decoration = firstMeld.querySelector<HTMLElement>(selector);
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
      backgroundColor: getComputedStyle(firstMeld).backgroundColor,
      numberVisible: decorationVisible(".meld-number"),
      statusVisible: decorationVisible(".meld-status"),
      meldRects: elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
      tileRects: [...firstMeld.querySelectorAll<HTMLElement>(".tile")].map((tile) => {
        const bounds = tile.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
      interMeldGap: secondBounds.x - firstBounds.right,
    };
  });
  expect(hoveredChrome.backgroundColor, "hover should reveal the meld background")
    .not.toBe("rgba(0, 0, 0, 0)");
  expect(hoveredChrome.numberVisible, "hover should not restore the removed meld number").toBe(false);
  expect(hoveredChrome.statusVisible, "hover should not change validation-status visibility")
    .toBe(restingChrome.invalid);
  expect(hoveredChrome.meldRects, "hover must not change any meld's position or size")
    .toEqual(restingChrome.meldRects);
  expect(hoveredChrome.tileRects, "hover must not move the tiles within the meld")
    .toEqual(restingChrome.tileRects);
  expect(hoveredChrome.interMeldGap, "hover must preserve the space between melds")
    .toBe(restingChrome.interMeldGap);

  await page.locator(".table-topline").hover();
  await handle.focus();
  await expect(handle).toBeFocused();
  await expect(handle).toBeVisible();
  await expect(handle).toHaveCSS("opacity", "1");
  await expect(handle).toHaveCSS("pointer-events", "auto");
  await page.keyboard.press("Enter");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await expect(meld).toHaveClass(/\bis-dragging\b/);
  expect(Number.parseFloat(await meld.evaluate((element) => getComputedStyle(element).opacity)))
    .toBeLessThan(1);

  await page.keyboard.press("Escape");
  await expect(meld).not.toHaveClass(/\bis-dragging\b/);
  await page.locator(".table-topline").hover();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    const dropTarget = melds.nth(1);
    await meld.dispatchEvent("dragstart", { dataTransfer });
    await expect(meld).toHaveClass(/\bis-dragging\b/);
    await dropTarget.dispatchEvent("dragover", { dataTransfer });
    await expect(dropTarget).toHaveClass(/\bis-drop-target\b/);
    await expect.poll(() => dropTarget.evaluate((element) => ({
      backgroundColor: getComputedStyle(element).backgroundColor,
      boxShadow: getComputedStyle(element).boxShadow,
    }))).not.toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      boxShadow: "none",
    });
    await meld.dispatchEvent("dragend", { dataTransfer });
    await expect(dropTarget).not.toHaveClass(/\bis-drop-target\b/);
  } finally {
    await dataTransfer.dispose();
  }
});
