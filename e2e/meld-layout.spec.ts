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
  melds: Rect[];
  rows: Rect[][];
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

async function addDraftMeld(page: Page): Promise<void> {
  const melds = page.locator(".melds .meld");
  const expectedCount = await melds.count() + 1;
  await page.locator(".rack .tile").first().press("Alt+Enter");
  await expect(melds).toHaveCount(expectedCount);
}

async function readMeldLayout(page: Page): Promise<MeldLayout> {
  return page.evaluate(() => {
    function rect(selector: string): Rect {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing layout element: ${selector}`);
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }

    const melds = [...document.querySelectorAll<HTMLElement>(".melds .meld")].map((meld) => {
      const { x, y, width, height } = meld.getBoundingClientRect();
      return { x, y, width, height };
    });
    const rows = melds.reduce<Rect[][]>((visualRows, meld) => {
      const currentRow = visualRows.at(-1);
      if (currentRow && Math.abs(currentRow[0]!.y - meld.y) <= 1) currentRow.push(meld);
      else visualRows.push([meld]);
      return visualRows;
    }, []);
    return { board: rect(".melds"), melds, rows };
  });
}

function contentBounds(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function expectCenteredAndContained({ board, melds }: MeldLayout): void {
  const contents = contentBounds(melds);
  const boardCenterX = board.x + board.width / 2;
  const boardCenterY = board.y + board.height / 2;
  const contentsCenterX = contents.x + contents.width / 2;
  const contentsCenterY = contents.y + contents.height / 2;

  expect(Math.abs(contentsCenterX - boardCenterX), "melds should be horizontally centered on the board")
    .toBeLessThanOrEqual(centerTolerancePx);
  expect(Math.abs(contentsCenterY - boardCenterY), "melds should be vertically centered on the board")
    .toBeLessThanOrEqual(centerTolerancePx);

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

function expectRowsCentered(layout: MeldLayout, expectedRowLengths: number[]): void {
  expect(layout.rows.map((row) => row.length)).toEqual(expectedRowLengths);
  const boardCenterX = layout.board.x + layout.board.width / 2;
  for (const [index, row] of layout.rows.entries()) {
    const rowBounds = contentBounds(row);
    const rowCenterX = rowBounds.x + rowBounds.width / 2;
    expect(Math.abs(rowCenterX - boardCenterX), `row ${index + 1} should be horizontally centered`)
      .toBeLessThanOrEqual(centerTolerancePx);
  }
}

test("grows melds outward from the center and fills the width before adding a fourth row", async ({ page, request }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await startTwoPlayerGame(page, request);

  const expectedRowsByMeldCount = [
    [1],
    [2],
    [2, 1],
    [2, 2],
    [3, 2],
    [3, 3],
    [3, 3, 1],
    [3, 3, 2],
    [3, 3, 3],
  ];

  for (const [index, expectedRows] of expectedRowsByMeldCount.entries()) {
    await addDraftMeld(page);
    const layout = await readMeldLayout(page);
    expect(layout.melds).toHaveLength(index + 1);
    expectCenteredAndContained(layout);
    expectRowsCentered(layout, expectedRows);
  }

  const threeRowLayout = await readMeldLayout(page);
  expect(threeRowLayout.rows).toHaveLength(3);
  const boardMetrics = await page.locator(".melds").evaluate((board) => ({
    clientHeight: board.clientHeight,
    scrollHeight: board.scrollHeight,
  }));
  expect(boardMetrics.scrollHeight, "three rows of melds should fit without vertical scrolling")
    .toBeLessThanOrEqual(boardMetrics.clientHeight + edgeTolerancePx);

  for (let meldCount = 10; meldCount <= 13; meldCount += 1) await addDraftMeld(page);
  const widthFillingLayout = await readMeldLayout(page);
  expect(widthFillingLayout.melds).toHaveLength(13);
  expect(widthFillingLayout.rows.length, "available width should be used before a fourth row is added")
    .toBeLessThanOrEqual(3);
  expectCenteredAndContained(widthFillingLayout);
  await expect(page.locator(".meld-grid")).toHaveClass(/\bfills-width\b/);
});

test("centers melds and reflows them without horizontal overflow at a narrow width", async ({ page, request }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await startTwoPlayerGame(page, request);

  await addDraftMeld(page);
  const firstLayout = await readMeldLayout(page);
  expect(firstLayout.melds).toHaveLength(1);
  expectCenteredAndContained(firstLayout);

  await addDraftMeld(page);
  const secondLayout = await readMeldLayout(page);
  expect(secondLayout.melds).toHaveLength(2);
  expectCenteredAndContained(secondLayout);
  expect(secondLayout.melds[0]!.y, "the existing meld should shift up when a new meld needs room")
    .toBeLessThan(firstLayout.melds[0]!.y - 1);
  expect(secondLayout.melds[1]!.y, "narrow melds should reflow to a new row")
    .toBeGreaterThan(secondLayout.melds[0]!.y + secondLayout.melds[0]!.height);

  const overflow = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);
});

test("keeps idle meld chrome invisible and reveals it without moving the melds", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await startTwoPlayerGame(page, request);
  await addDraftMeld(page);
  await addDraftMeld(page);

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
  expect(restingChrome.backgroundColor, "a resting meld should have a transparent background")
    .toBe("rgba(0, 0, 0, 0)");
  expect(restingChrome.backgroundImage).toBe("none");
  expect(restingChrome.boxShadow).toBe("none");
  expect(restingChrome.numberVisible, "the meld number should never be visible").toBe(false);
  expect(restingChrome.statusVisible, "the meld status should never be visible").toBe(false);
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
  expect(hoveredChrome.statusVisible, "hover should not restore the removed meld status").toBe(false);
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
