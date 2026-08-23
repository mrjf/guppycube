import { expect, test, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const computerRackPreferenceKey = "guppycube:show-computer-racks";
const maxLayoutShiftPx = 0.5;

interface ComputerGameState {
  currentPlayerId: string | null;
  myPlayerId: string;
  players: Array<{
    id: string;
    name: string;
    rackCount: number;
    rackTileIds: string[];
    isComputer: boolean;
    computerStrategy: "basic" | null;
  }>;
  history: Array<{
    playerId: string | null;
    kind: "created" | "joined" | "started" | "played" | "drew" | "timeout" | "won";
    message: string;
  }>;
}

async function getGameState(page: Page, roomCode: string): Promise<ComputerGameState> {
  const url = `${appUrl}/api/games/${roomCode}`;
  let lastFailure = "unknown error";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await page.evaluate(async (requestUrl) => {
      try {
        const response = await fetch(requestUrl, { credentials: "same-origin", cache: "no-store" });
        return response.ok
          ? { ok: true as const, state: await response.json() as ComputerGameState }
          : { ok: false as const, failure: `${response.status}: ${await response.text()}` };
      } catch (error) {
        return { ok: false as const, failure: error instanceof Error ? error.message : String(error) };
      }
    }, url);
    if (result.ok) return result.state;
    lastFailure = result.failure;
    await page.waitForTimeout(250);
  }
  throw new Error(`Game state failed after retries: ${lastFailure}`);
}

interface ElementLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function playerStripLayout(page: Page): Promise<ElementLayout[]> {
  return page.locator(".players-strip > .player-card, .players-strip > .turn-clock").evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

function expectStableLayout(before: ElementLayout[], after: ElementLayout[], message: string): void {
  expect(after, `${message}: element count`).toHaveLength(before.length);
  for (const [index, beforeRect] of before.entries()) {
    const afterRect = after[index]!;
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(afterRect[dimension] - beforeRect[dimension]),
        `${message}: element ${index} ${dimension} changed from ${beforeRect[dimension]} to ${afterRect[dimension]}`,
      ).toBeLessThanOrEqual(maxLayoutShiftPx);
    }
  }
}

async function expectInteractiveWidthsStable(page: Page): Promise<void> {
  const interactiveElements = page.locator([
    "a:visible",
    "button:visible",
    "input:visible",
    "select:visible",
    "textarea:visible",
    ".player-card:visible",
    "[tabindex]:visible",
  ].join(", "));
  const count = await interactiveElements.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const element = interactiveElements.nth(index);
    if (!await element.isVisible()) continue;
    const label = await element.evaluate((node) =>
      node.getAttribute("aria-label")
      ?? node.getAttribute("title")
      ?? node.textContent?.trim().slice(0, 40)
      ?? `${node.tagName.toLocaleLowerCase()} ${node.className}`,
    );
    const beforeWidth = await element.evaluate((node) => (node as HTMLElement).offsetWidth);
    await element.hover();
    expect(
      await element.evaluate((node) => (node as HTMLElement).offsetWidth),
      `${label || `interactive element ${index}`} changed width on hover`,
    ).toBe(beforeWidth);

    const focusable = await element.evaluate((node) =>
      node instanceof HTMLElement && node.tabIndex >= 0 && !node.matches(":disabled"),
    );
    if (focusable) {
      await element.focus();
      expect(
        await element.evaluate((node) => (node as HTMLElement).offsetWidth),
        `${label || `interactive element ${index}`} changed width on focus`,
      ).toBe(beforeWidth);
    }
  }
  await page.mouse.move(0, 0);
}

async function expectFullPlayerRow(page: Page, cardSelector: string): Promise<void> {
  const layout = await page.evaluate((selector) => {
    const strip = document.querySelector<HTMLElement>(".players-strip");
    const cards = [...document.querySelectorAll<HTMLElement>(selector)];
    if (!strip || cards.length === 0) throw new Error(`Missing player-row element: ${selector}`);
    const stripStyle = getComputedStyle(strip);
    return {
      cardWidths: cards.map((card) => card.getBoundingClientRect().width),
      contentWidth: strip.clientWidth
        - Number.parseFloat(stripStyle.paddingLeft)
        - Number.parseFloat(stripStyle.paddingRight),
    };
  }, cardSelector);
  for (const cardWidth of layout.cardWidths) {
    expect(Math.abs(cardWidth - layout.contentWidth)).toBeLessThanOrEqual(maxLayoutShiftPx);
  }
}

function expectSeparateRows(first: ElementLayout, second: ElementLayout, message: string): void {
  const [top, bottom] = [first, second].sort((left, right) => left.y - right.y);
  expect(bottom!.y, message).toBeGreaterThanOrEqual(top!.y + top!.height);
}

test("configures a basic computer, reveals its rack, and observes its autonomous turn", async ({ page }) => {
  test.setTimeout(60_000);
  const playerName = `Bot host ${Date.now().toString(36).slice(-7)}`;

  await page.addInitScript((preferenceKey) => {
    const testWindow = window as typeof window & { computerRackPreferenceInitiallyAbsent?: boolean };
    testWindow.computerRackPreferenceInitiallyAbsent = localStorage.getItem(preferenceKey) === null;
  }, computerRackPreferenceKey);
  await page.goto(appUrl);
  expect(await page.evaluate(() =>
    (window as typeof window & { computerRackPreferenceInitiallyAbsent?: boolean }).computerRackPreferenceInitiallyAbsent,
  )).toBe(true);
  await page.getByLabel("Your name").fill(playerName);
  await page.locator(".player-count").getByRole("button", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Create table" }).click();
  await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();

  const roomCode = await page.locator(".invite-code strong").innerText();
  const strategy = page.getByLabel("Computer strategy");
  await expect(strategy).toHaveValue("basic");
  await expect(strategy.locator("option")).toHaveText(["Basic"]);
  await strategy.selectOption("basic");
  await page.getByRole("button", { name: "Add computer" }).click();

  const computerSeat = page.locator(".seat.is-computer");
  await expect(computerSeat).toHaveCount(1);
  await expect(computerSeat.getByText("Guppy Bot", { exact: true })).toBeVisible();
  await expect(computerSeat.getByText("Computer · basic", { exact: true })).toBeVisible();
  await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add computer" })).toHaveCount(0);

  const lobbyState = await getGameState(page, roomCode);
  const computer = lobbyState.players.find((player) => player.isComputer);
  expect(computer).toEqual(expect.objectContaining({
    name: "Guppy Bot",
    rackCount: 0,
    isComputer: true,
    computerStrategy: "basic",
  }));

  await page.getByRole("button", { name: "Shuffle & start" }).click();
  await expect(page.getByLabel("Game table")).toBeVisible();

  const startedState = await getGameState(page, roomCode);
  if (startedState.currentPlayerId === startedState.myPlayerId) {
    await page.getByRole("button", { name: "Draw & end" }).click();
  }

  await expect.poll(async () => {
    const state = await getGameState(page, roomCode);
    return state.history.some((item) =>
      item.playerId === computer!.id && (item.kind === "drew" || item.kind === "played"),
    );
  }, {
    message: "the configured computer should take its own turn",
    timeout: 10_000,
  }).toBe(true);

  const computerCard = page.locator(".player-card").filter({ hasText: "Guppy Bot" });
  const actionFlash = computerCard.locator(".player-action-flash");
  await expect(actionFlash).toBeVisible();
  await expect(actionFlash).toContainText(/(drew|played)/i);

  const afterComputerTurn = await getGameState(page, roomCode);
  const computerAfter = afterComputerTurn.players.find((player) => player.id === computer!.id)!;
  expect(afterComputerTurn.currentPlayerId).toBe(afterComputerTurn.myPlayerId);
  expect(computerAfter.rackCount).not.toBe(14);
  expect(computerAfter.rackTileIds).toHaveLength(computerAfter.rackCount);
  expect(computerAfter.rackTileIds.length).toBeGreaterThan(0);
  expect(afterComputerTurn.players.filter((player) => !player.isComputer)).not.toHaveLength(0);
  expect(afterComputerTurn.players.filter((player) => !player.isComputer).every((player) =>
    player.rackTileIds.length === 0,
  )).toBe(true);
  await expect(page.getByText("Your turn", { exact: true })).toBeVisible();

  await expect(computerCard.getByText("Computer · basic", { exact: true })).toBeVisible();
  await expect(actionFlash).toHaveCount(0, { timeout: 5_000 });
  await expectInteractiveWidthsStable(page);
  const beforeHover = await playerStripLayout(page);
  await computerCard.hover();
  await expect(computerCard.locator(".player-last-turn")).toBeVisible();
  await expect(computerCard.locator(".player-last-turn")).toContainText(/Last: (drew|played)/i);
  expectStableLayout(beforeHover, await playerStripLayout(page), "computer-card hover");
  await page.mouse.move(0, 0);
  await expect(computerCard.locator(".player-last-turn")).toBeHidden();
  await page.getByRole("button", { name: "Leave table" }).focus();
  await page.keyboard.press("Tab");
  if (!await computerCard.evaluate((card) => card === document.activeElement)) await page.keyboard.press("Tab");
  await expect(computerCard).toBeFocused();
  await expect(computerCard.locator(".player-last-turn")).toBeVisible();
  expectStableLayout(beforeHover, await playerStripLayout(page), "computer-card focus");
  const showComputerRack = computerCard.getByRole("button", { name: "Show Guppy Bot's rack" });
  await expect(showComputerRack).toBeVisible();
  await expect(showComputerRack).toHaveAttribute("aria-pressed", "false");
  await expect(computerCard.locator(".computer-rack-inline")).toHaveCount(0);
  await expect(page.locator(".players-strip > .computer-rack-toggle")).toHaveCount(0);

  await showComputerRack.click();
  const computerRack = computerCard.locator(".computer-rack-inline");
  await expect(computerCard).toHaveClass(/\bis-rack-open\b/);
  await expect(computerCard.getByRole("button", { name: "Hide Guppy Bot's rack" })).toHaveAttribute("aria-pressed", "true");
  await expect(computerRack).toBeVisible();
  await expect(computerRack.getByText(`${computerAfter.rackCount} visible tiles`, { exact: true })).toBeVisible();
  await expect(computerRack.locator(".computer-rack-tiles .tile")).toHaveCount(computerAfter.rackTileIds.length);
  const visibleComputerTileIds = await computerRack.locator(".computer-rack-tiles .tile").evaluateAll((tiles) =>
    tiles.map((tile) => (tile as HTMLElement).dataset.tileId),
  );
  expect([...visibleComputerTileIds].sort()).toEqual([...computerAfter.rackTileIds].sort());
  await expectFullPlayerRow(page, ".player-card.is-computer.is-rack-open");
  expect(JSON.parse(await page.evaluate(
    (preferenceKey) => localStorage.getItem(preferenceKey) ?? "[]",
    computerRackPreferenceKey,
  ))).toEqual([computer!.id]);

  await page.reload();
  await expect(page.locator(".player-action-flash")).toHaveCount(0);
  const reloadedComputerCard = page.locator(".player-card.is-computer").filter({ hasText: "Guppy Bot" });
  await expect(reloadedComputerCard.getByRole("button", { name: "Hide Guppy Bot's rack" })).toBeVisible();
  await expect(reloadedComputerCard.locator(".computer-rack-tiles .tile")).toHaveCount(computerAfter.rackTileIds.length);
  await reloadedComputerCard.getByRole("button", { name: "Hide Guppy Bot's rack" }).click();
  await expect(reloadedComputerCard.locator(".computer-rack-inline")).toHaveCount(0);
  expect(await page.evaluate((preferenceKey) => localStorage.getItem(preferenceKey), computerRackPreferenceKey)).toBe("[]");

  await page.reload();
  const closedComputerCard = page.locator(".player-card.is-computer").filter({ hasText: "Guppy Bot" });
  await expect(closedComputerCard.getByRole("button", { name: "Show Guppy Bot's rack" })).toHaveAttribute("aria-pressed", "false");
  await expect(closedComputerCard.locator(".computer-rack-inline")).toHaveCount(0);
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.locator(".activity-panel")).toContainText(/Guppy Bot (drew|played)/);
});

test("keeps two computer rack toggles inside their cards and expands each player independently", async ({ page }) => {
  test.setTimeout(60_000);
  const playerName = `Two bots ${Date.now().toString(36).slice(-7)}`;

  await page.goto(appUrl);
  await page.getByLabel("Your name").fill(playerName);
  await page.locator(".player-count").getByRole("button", { name: "3", exact: true }).click();
  await page.getByRole("button", { name: "Create table" }).click();
  await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();
  const roomCode = await page.locator(".invite-code strong").innerText();

  await page.getByRole("button", { name: "Add computer" }).click();
  await expect(page.locator(".seat.is-computer")).toHaveCount(1);
  await page.getByRole("button", { name: "Add computer" }).click();
  await expect(page.locator(".seat.is-computer")).toHaveCount(2);
  await page.getByRole("button", { name: "Shuffle & start" }).click();
  await expect(page.getByLabel("Game table")).toBeVisible();
  const humanPlayerId = (await getGameState(page, roomCode)).myPlayerId;
  await expect.poll(async () => (await getGameState(page, roomCode)).currentPlayerId, {
    message: "computer opening turns should settle back on the human player",
    timeout: 10_000,
  }).toBe(humanPlayerId);
  await expect(page.locator(".player-action-flash")).toHaveCount(0, { timeout: 5_000 });

  const cards = page.locator(".players-strip > .player-card.is-computer");
  const firstCard = cards.filter({ has: page.getByText("Guppy Bot", { exact: true }) });
  const secondCard = cards.filter({ has: page.getByText("Guppy Bot 2", { exact: true }) });
  const firstToggle = firstCard.getByRole("button", { name: "Show Guppy Bot's rack" });
  const secondToggle = secondCard.getByRole("button", { name: "Show Guppy Bot 2's rack" });
  await expect(cards).toHaveCount(2);
  await expect(firstToggle).toHaveCount(1);
  await expect(secondToggle).toHaveCount(1);
  await expect(page.locator(".players-strip > .computer-rack-toggle")).toHaveCount(0);
  await expect(firstCard.locator(".computer-rack-inline")).toHaveCount(0);
  await expect(secondCard.locator(".computer-rack-inline")).toHaveCount(0);

  const closedBoxes = await cards.evaluateAll((elements) => elements.map((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  }));
  expect(closedBoxes[0]?.width).toBeGreaterThan(0);
  expect(closedBoxes[1]?.width).toBeCloseTo(closedBoxes[0]!.width, 5);
  expect(closedBoxes[1]?.height).toBeCloseTo(closedBoxes[0]!.height, 5);

  await firstToggle.click();
  await expect(firstCard).toHaveClass(/\bis-rack-open\b/);
  await expect(firstCard.getByRole("button", { name: "Hide Guppy Bot's rack" })).toHaveAttribute("aria-pressed", "true");
  await expect(secondCard).not.toHaveClass(/\bis-rack-open\b/);
  await expect(secondToggle).toHaveAttribute("aria-pressed", "false");
  await expect(firstCard.locator(".computer-rack-inline")).toBeVisible();
  await expect(secondCard.locator(".computer-rack-inline")).toHaveCount(0);
  await expectFullPlayerRow(page, ".player-card.is-computer.is-rack-open");

  const firstOpenBox = await firstCard.boundingBox();
  const secondClosedBox = await secondCard.boundingBox();
  expect(firstOpenBox).not.toBeNull();
  expect(secondClosedBox).not.toBeNull();
  expectSeparateRows(firstOpenBox!, secondClosedBox!, "an expanded computer card should not overlap the other card");
  expect(secondClosedBox!.width).toBeCloseTo(closedBoxes[0]!.width, 5);

  let storedOpenIds = JSON.parse(await page.evaluate(
    (preferenceKey) => localStorage.getItem(preferenceKey) ?? "[]",
    computerRackPreferenceKey,
  )) as string[];
  let state = await getGameState(page, roomCode);
  const firstComputer = state.players.find((player) => player.name === "Guppy Bot")!;
  const secondComputer = state.players.find((player) => player.name === "Guppy Bot 2")!;
  expect(storedOpenIds).toEqual([firstComputer.id]);

  await secondToggle.click();
  await expect(firstCard).toHaveClass(/\bis-rack-open\b/);
  await expect(secondCard).toHaveClass(/\bis-rack-open\b/);
  await expect(firstCard.locator(".computer-rack-inline")).toBeVisible();
  await expect(secondCard.locator(".computer-rack-inline")).toBeVisible();
  await expectFullPlayerRow(page, ".player-card.is-computer.is-rack-open");

  const firstExpandedBox = await firstCard.boundingBox();
  const secondExpandedBox = await secondCard.boundingBox();
  expect(firstExpandedBox).not.toBeNull();
  expect(secondExpandedBox).not.toBeNull();
  expectSeparateRows(firstExpandedBox!, secondExpandedBox!, "expanded computer cards should not overlap");

  state = await getGameState(page, roomCode);
  for (const computer of [firstComputer, secondComputer]) {
    const currentComputer = state.players.find((player) => player.id === computer.id)!;
    const card = computer.name === "Guppy Bot" ? firstCard : secondCard;
    await expect(card.locator(".computer-rack-tiles .tile")).toHaveCount(currentComputer.rackTileIds.length);
    const tileIds = await card.locator(".computer-rack-tiles .tile").evaluateAll((tiles) =>
      tiles.map((tile) => (tile as HTMLElement).dataset.tileId).sort(),
    );
    expect(tileIds).toEqual([...currentComputer.rackTileIds].sort());
  }

  storedOpenIds = JSON.parse(await page.evaluate(
    (preferenceKey) => localStorage.getItem(preferenceKey) ?? "[]",
    computerRackPreferenceKey,
  )) as string[];
  expect(storedOpenIds.sort()).toEqual([firstComputer.id, secondComputer.id].sort());

  await firstCard.getByRole("button", { name: "Hide Guppy Bot's rack" }).click();
  await expect(firstCard).not.toHaveClass(/\bis-rack-open\b/);
  await expect(secondCard).toHaveClass(/\bis-rack-open\b/);
  await expect(firstCard.locator(".computer-rack-inline")).toHaveCount(0);
  await expect(secondCard.locator(".computer-rack-inline")).toBeVisible();
  expect(JSON.parse(await page.evaluate(
    (preferenceKey) => localStorage.getItem(preferenceKey) ?? "[]",
    computerRackPreferenceKey,
  ))).toEqual([secondComputer.id]);

  await page.reload();
  const reloadedCards = page.locator(".players-strip > .player-card.is-computer");
  const reloadedFirst = reloadedCards.filter({ has: page.getByText("Guppy Bot", { exact: true }) });
  const reloadedSecond = reloadedCards.filter({ has: page.getByText("Guppy Bot 2", { exact: true }) });
  await expect(reloadedFirst).not.toHaveClass(/\bis-rack-open\b/);
  await expect(reloadedFirst.getByRole("button", { name: "Show Guppy Bot's rack" })).toBeVisible();
  await expect(reloadedSecond).toHaveClass(/\bis-rack-open\b/);
  await expect(reloadedSecond.getByRole("button", { name: "Hide Guppy Bot 2's rack" })).toBeVisible();
  await expectFullPlayerRow(page, ".player-card.is-computer.is-rack-open");
});
