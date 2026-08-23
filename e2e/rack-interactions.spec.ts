import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const colors = ["coral", "sun", "ocean", "ink"] as const;

type SortMode = "color-first" | "number-first";
type TileColor = typeof colors[number];

interface Session {
  roomCode: string;
}

interface Tile {
  id: string;
  color: TileColor | null;
  value: number | null;
  wildcard: boolean;
}

interface GameState {
  id: string;
  currentPlayerId: string | null;
  myPlayerId: string;
  myRack: string[];
  players: Array<{ id: string; name: string }>;
  tiles: Record<string, Tile>;
}

interface ApiPlayer {
  api: APIRequestContext;
  session: Session;
}

interface LinkedTiles {
  heldId: string;
  tileIds: string[];
  kind: "group" | "run";
  sortMode: SortMode;
  sortedRack: string[];
  singletonId: string;
}

interface RackGame {
  players: ApiPlayer[];
  target: ApiPlayer;
  state: GameState;
  linked: LinkedTiles;
}

function colorRank(tile: Tile | undefined): number {
  return tile?.color ? colors.indexOf(tile.color) : colors.length;
}

function numberRank(tile: Tile | undefined): number {
  return tile?.value ?? 14;
}

function sortRack(tileIds: string[], tiles: Record<string, Tile>, mode: SortMode): string[] {
  return [...tileIds].sort((leftId, rightId) => {
    const left = tiles[leftId];
    const right = tiles[rightId];
    const primary = mode === "color-first"
      ? colorRank(left) - colorRank(right)
      : numberRank(left) - numberRank(right);
    const secondary = mode === "color-first"
      ? numberRank(left) - numberRank(right)
      : colorRank(left) - colorRank(right);
    return primary || secondary || leftId.localeCompare(rightId);
  });
}

function meldKind(tileIds: string[], tiles: Record<string, Tile>): "group" | "run" | null {
  const meldTiles = tileIds.map((id) => tiles[id]).filter((tile): tile is Tile => Boolean(tile));
  if (meldTiles.length !== tileIds.length) return null;

  if (meldTiles.length >= 3 && meldTiles.length <= 4) {
    const numbered = meldTiles.filter((tile) => !tile.wildcard);
    const value = numbered[0]?.value;
    const usedColors = numbered.map((tile) => tile.color);
    if (
      numbered.length > 0
      && value !== null
      && value !== undefined
      && numbered.every((tile) => tile.value === value)
      && usedColors.every(Boolean)
      && new Set(usedColors).size === usedColors.length
    ) return "group";
  }

  if (meldTiles.length < 3 || meldTiles.length > 13) return null;
  const numbered = meldTiles
    .map((tile, index) => ({ tile, index }))
    .filter(({ tile }) => !tile.wildcard);
  const first = numbered[0];
  if (!first?.tile.color || first.tile.value === null) return null;
  const start = first.tile.value - first.index;
  if (start < 1 || start + meldTiles.length - 1 > 13) return null;
  if (numbered.some(({ tile }) => tile.color !== first.tile.color)) return null;
  if (numbered.some(({ tile, index }) => tile.value !== start + index)) return null;
  return "run";
}

function linkedForHeld(sortedRack: string[], heldId: string, tiles: Record<string, Tile>): string[] {
  const heldIndex = sortedRack.indexOf(heldId);
  if (heldIndex < 0) return [];

  let linked = [heldId];
  for (let start = 0; start <= heldIndex; start += 1) {
    for (let end = heldIndex + 1; end <= sortedRack.length; end += 1) {
      const candidate = sortedRack.slice(start, end);
      if (candidate.length > linked.length && meldKind(candidate, tiles)) linked = candidate;
    }
  }
  return linked;
}

function findLinkedTiles(state: GameState): LinkedTiles | null {
  for (const sortMode of ["color-first", "number-first"] as const) {
    const sortedRack = sortRack(state.myRack, state.tiles, sortMode);
    const linkedCandidates = sortedRack.map((heldId) => ({
      heldId,
      tileIds: linkedForHeld(sortedRack, heldId, state.tiles),
    }));
    const linked = linkedCandidates.find((candidate) => candidate.tileIds.length > 1);
    const singleton = linkedCandidates.find((candidate) => candidate.tileIds.length === 1);
    const kind = linked ? meldKind(linked.tileIds, state.tiles) : null;
    if (linked && kind && singleton) {
      return {
        ...linked,
        kind,
        sortMode,
        sortedRack,
        singletonId: singleton.heldId,
      };
    }
  }
  return null;
}

async function readJson<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) throw new Error(`${response.url()} failed: ${response.status()} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function createPlayer(name: string, roomCode?: string): Promise<ApiPlayer> {
  const api = await playwrightRequest.newContext({ baseURL: appUrl });
  const response = roomCode
    ? await api.post(`/api/games/${roomCode}/join`, { data: { name } })
    : await api.post("/api/games", { data: { name, mode: "realtime", maxPlayers: 4 } });
  try {
    const session = await readJson<Session>(response);
    return { api, session };
  } catch (error) {
    await api.dispose();
    throw error;
  }
}

async function getState(player: ApiPlayer): Promise<GameState> {
  return readJson<GameState>(
    await player.api.get(`/api/games/${player.session.roomCode}`),
  );
}

async function disposePlayers(players: ApiPlayer[]): Promise<void> {
  await Promise.all(players.map((player) => player.api.dispose()));
}

async function dragRackTileToSlot(page: Page, tile: Locator, slot: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await tile.dispatchEvent("dragstart", { dataTransfer });
    await slot.dispatchEvent("dragover", { dataTransfer });
    await slot.dispatchEvent("drop", { dataTransfer });
    await tile.dispatchEvent("dragend", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

async function rackSlotSnapshot(page: Page): Promise<Array<string | null>> {
  return page.locator(".rack-slot").evaluateAll((slots) => {
    const byIndex: Array<string | null> = [];
    for (const slot of slots) {
      const slotIndex = Number.parseInt((slot as HTMLElement).dataset.rackSlot ?? "", 10);
      if (!Number.isInteger(slotIndex)) throw new Error("Rack slot is missing a numeric data-rack-slot value.");
      byIndex[slotIndex] = slot.querySelector<HTMLElement>(".tile")?.dataset.tileId ?? null;
    }
    return byIndex;
  });
}

async function createRackGame(): Promise<RackGame> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stamp = `${Date.now().toString(36).slice(-6)}${attempt}`;
    const players: ApiPlayer[] = [];
    try {
      const host = await createPlayer(`RH-${stamp}`);
      players.push(host);
      for (let seat = 2; seat <= 4; seat += 1) {
        players.push(await createPlayer(`RP${seat}-${stamp}`, host.session.roomCode));
      }

      const startResponse = await host.api.post(`/api/games/${host.session.roomCode}/start`, { data: {} });
      await readJson<{ ok: true }>(startResponse);

      const states = await Promise.all(players.map(getState));
      const targetIndex = states.findIndex((state) => findLinkedTiles(state));
      if (targetIndex < 0) {
        await disposePlayers(players);
        continue;
      }

      const target = players[targetIndex]!;
      const state = states[targetIndex]!;
      const linked = findLinkedTiles(state)!;
      let targetState = state;
      for (let turn = 0; targetState.currentPlayerId !== targetState.myPlayerId && turn < players.length; turn += 1) {
        const currentIndex = states.findIndex((candidate) => candidate.myPlayerId === targetState.currentPlayerId);
        const current = players[currentIndex];
        if (!current || !targetState.currentPlayerId) throw new Error("Could not identify the current player.");
        await readJson<{ ok: true }>(
          await current.api.post(`/api/games/${current.session.roomCode}/action`, {
            data: { action: { type: "draw" } },
          }),
        );
        targetState = await getState(target);
      }
      if (targetState.currentPlayerId !== targetState.myPlayerId) {
        throw new Error("Could not advance to the linked-rack player.");
      }

      return { players, target, state: targetState, linked };
    } catch (error) {
      await disposePlayers(players);
      throw error;
    }
  }
  throw new Error("Eight four-player deals did not contain a testable sorted run/group and singleton.");
}

test("gates sorted rack meld underlines behind an off-by-default assist", async ({ browser }) => {
  test.setTimeout(60_000);
  const rackGame = await createRackGame();
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({ storageState: await rackGame.target.api.storageState() });
    const page = await context.newPage();
    await page.goto(`${appUrl}/room/${rackGame.target.session.roomCode}`);
    await expect(page.getByText("Your turn", { exact: true })).toBeVisible();

    const rows = page.locator(".rack [data-rack-row]");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-rack-row", "1");
    await expect(rows.nth(1)).toHaveAttribute("data-rack-row", "2");
    await expect(rows.nth(0).locator(".tile")).toHaveCount(Math.ceil(rackGame.state.myRack.length / 2));
    await expect(rows.nth(1).locator(".tile")).toHaveCount(Math.floor(rackGame.state.myRack.length / 2));

    const rowBoxes = await rows.evaluateAll((levels) => levels.map((level) => {
      const box = level.getBoundingClientRect();
      const tileBoxes = [...level.querySelectorAll<HTMLElement>(".tile")].map((tile) => tile.getBoundingClientRect());
      return {
        left: box.left,
        width: box.width,
        top: box.top,
        tileTops: tileBoxes.map((tile) => tile.top),
        tileLefts: tileBoxes.map((tile) => tile.left),
        tileRights: tileBoxes.map((tile) => tile.right),
      };
    }));
    expect(rowBoxes[1]!.top).toBeGreaterThan(rowBoxes[0]!.top);
    for (const row of rowBoxes) {
      expect(Math.max(...row.tileTops) - Math.min(...row.tileTops)).toBeLessThan(2);
      expect(row.tileLefts.every((left, index) => index === 0 || left > row.tileLefts[index - 1]!)).toBe(true);
      const tilesCenter = (Math.min(...row.tileLefts) + Math.max(...row.tileRights)) / 2;
      expect(Math.abs(tilesCenter - (row.left + row.width / 2)), "rack row tiles should be centered")
        .toBeLessThan(2);
    }

    const sortButtonName = rackGame.linked.sortMode === "color-first" ? "Color → 123" : "123 → Color";
    await page.getByRole("button", { name: sortButtonName }).click();
    const displayedTileIds = await page.locator(".rack .tile").evaluateAll((tiles) =>
      tiles.map((tile) => (tile as HTMLElement).dataset.tileId),
    );
    expect(displayedTileIds).toEqual(rackGame.linked.sortedRack);

    const meldSlots = page.locator('.rack-slot[data-rack-meld="true"]');
    await expect(meldSlots).toHaveCount(0);

    await page.getByRole("button", { name: "Assists" }).click();
    const rackMeldHighlights = page.locator(".assist-panel").getByRole("switch", { name: "Rack meld highlights" });
    await expect(rackMeldHighlights).not.toBeChecked();
    await rackMeldHighlights.click();
    await expect(rackMeldHighlights).toBeChecked();
    await expect(meldSlots).not.toHaveCount(0);
    expect(await meldSlots.locator(".tile").count()).toBeGreaterThanOrEqual(3);

    await rackMeldHighlights.click();
    await expect(rackMeldHighlights).not.toBeChecked();
    await expect(meldSlots).toHaveCount(0);
    await rackMeldHighlights.click();
    await expect(rackMeldHighlights).toBeChecked();
    await page.getByRole("button", { name: "Assists" }).click();

    const firstSelectableId = rackGame.linked.heldId;
    const secondSelectableId = rackGame.linked.singletonId;
    const firstSelectable = page.locator(`.rack .tile[data-tile-id="${firstSelectableId}"]`);
    const secondSelectable = page.locator(`.rack .tile[data-tile-id="${secondSelectableId}"]`);
    await firstSelectable.click();
    await expect(firstSelectable).toHaveAttribute("aria-pressed", "true");
    await expect(secondSelectable).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(1);
    expect(await page.locator(".rack .tile").evaluateAll((tiles) =>
      tiles.map((tile) => (tile as HTMLElement).dataset.tileId),
    )).toEqual(displayedTileIds);
    await expect(page.locator(".meld")).toHaveCount(0);

    await secondSelectable.click();
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(2);
    await expect(firstSelectable).toHaveAttribute("aria-pressed", "true");
    await expect(secondSelectable).toHaveAttribute("aria-pressed", "true");
    expect(await page.locator(".rack .tile").evaluateAll((tiles) =>
      tiles.map((tile) => (tile as HTMLElement).dataset.tileId),
    )).toEqual(displayedTileIds);
    await expect(page.locator(".rack .tile")).toHaveCount(rackGame.state.myRack.length);
    await expect(page.locator(".meld")).toHaveCount(0);
    await firstSelectable.click();
    await secondSelectable.click();
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(0);

    const heldTileId = rackGame.linked.tileIds[0]!;
    const nextHeldTileId = rackGame.linked.tileIds[1]!;
    const thirdHeldTileId = rackGame.linked.tileIds[2]!;
    const heldTile = page.locator(`.rack .tile[data-tile-id="${heldTileId}"]`);
    await heldTile.dispatchEvent("pointerdown", { pointerType: "mouse", button: 0, isPrimary: true });
    await page.waitForTimeout(550);
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(1);
    await expect(heldTile).toHaveAttribute("aria-pressed", "true");

    await page.waitForTimeout(375);
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(2);
    await expect(page.locator(`.rack .tile[data-tile-id="${nextHeldTileId}"]`)).toHaveAttribute("aria-pressed", "true");

    await page.waitForTimeout(375);
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(3);
    await expect(page.locator(`.rack .tile[data-tile-id="${thirdHeldTileId}"]`)).toHaveAttribute("aria-pressed", "true");
    await heldTile.dispatchEvent("pointerup", { pointerType: "mouse", button: 0, isPrimary: true });
    await page.waitForTimeout(400);
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(3);

    await page.keyboard.press("Escape");
    await heldTile.focus();
    await page.keyboard.press("Shift+Enter");

    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(rackGame.linked.tileIds.length);
    for (const tileId of rackGame.linked.tileIds) {
      await expect(page.locator(`.rack .tile[data-tile-id="${tileId}"]`)).toHaveAttribute("aria-pressed", "true");
    }
    await expect(page.getByText(`Move ${rackGame.linked.tileIds.length} selected tiles to open table space or a meld`)).toBeVisible();

    await page.getByLabel("Game table").dispatchEvent("click");
    const newMeld = page.locator(".meld").last();
    await expect(newMeld).toBeVisible();
    await expect(newMeld).toContainText(rackGame.linked.kind);
    const placedTileIds = await newMeld.locator(".tile").evaluateAll((tiles) =>
      tiles.map((tile) => (tile as HTMLElement).dataset.tileId).sort(),
    );
    expect(placedTileIds).toEqual([...rackGame.linked.tileIds].sort());
    await expect(page.locator(".rack .tile")).toHaveCount(rackGame.state.myRack.length - rackGame.linked.tileIds.length);

    await page.getByRole("button", { name: "Reset turn" }).click();
    await expect(page.locator(".rack .tile")).toHaveCount(rackGame.state.myRack.length);
    await expect(page.locator(".meld")).toHaveCount(0);

    const singleton = page.locator(`.rack .tile[data-tile-id="${rackGame.linked.singletonId}"]`);
    await singleton.dispatchEvent("pointerdown", { pointerType: "mouse", button: 0, isPrimary: true });
    await page.waitForTimeout(550);
    await singleton.dispatchEvent("pointerup", { pointerType: "mouse", button: 0, isPrimary: true });
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(1);
    await expect(singleton).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Tap open table space to start a new meld, or tap a meld to add it")).toBeVisible();
  } finally {
    await context?.close();
    await disposePlayers(rackGame.players);
  }
});

test("keeps manual slots at a fixed pitch, rearranges while waiting, persists the layout, and resumes both sorts", async ({ browser }) => {
  test.setTimeout(60_000);
  const rackGame = await createRackGame();
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({ storageState: await rackGame.target.api.storageState() });
    const page = await context.newPage();
    await page.goto(`${appUrl}/room/${rackGame.target.session.roomCode}`);
    await expect(page.getByText("Your turn", { exact: true })).toBeVisible();

    const colorButton = page.getByRole("button", { name: "Color → 123", exact: true });
    const numberButton = page.getByRole("button", { name: "123 → Color", exact: true });
    await expect(page.getByRole("grid", { name: "Your rack, autosorted" })).toBeVisible();

    const initiallySortedTile = page.locator(".rack .tile").first();
    const activeTurnTarget = page.locator(".rack-slot").last();
    await dragRackTileToSlot(page, initiallySortedTile, activeTurnTarget);
    await expect(page.getByRole("grid", { name: "Your rack, manual arrangement" })).toBeVisible();
    await expect(colorButton).toHaveAttribute("aria-pressed", "false");
    await expect(numberButton).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Off", exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("guppycube:rack-autosort")))
      .toBe("false");

    const rows = page.locator(".rack [data-rack-row]");
    await expect(rows).toHaveCount(2);
    const rowGeometry = await rows.evaluateAll((rackRows) => rackRows.map((row) => ({
      left: row.getBoundingClientRect().left,
      right: row.getBoundingClientRect().right,
      slotIndices: [...row.querySelectorAll<HTMLElement>(":scope > .rack-slot")]
        .map((slot) => Number.parseInt(slot.dataset.rackSlot ?? "", 10)),
      slotLefts: [...row.querySelectorAll<HTMLElement>(":scope > .rack-slot")]
        .map((slot) => slot.getBoundingClientRect().left),
      slotRights: [...row.querySelectorAll<HTMLElement>(":scope > .rack-slot")]
        .map((slot) => slot.getBoundingClientRect().right),
    })));
    expect(rowGeometry[0]!.slotIndices.length).toBeGreaterThanOrEqual(14);
    expect(rowGeometry[1]!.slotIndices).toHaveLength(rowGeometry[0]!.slotIndices.length);
    expect(rowGeometry[0]!.slotIndices).toEqual(
      Array.from({ length: rowGeometry[0]!.slotIndices.length }, (_, index) => index * 2),
    );
    expect(rowGeometry[1]!.slotIndices).toEqual(
      Array.from({ length: rowGeometry[1]!.slotIndices.length }, (_, index) => index * 2 + 1),
    );
    rowGeometry[0]!.slotLefts.forEach((left, index) => {
      expect(Math.abs(left - rowGeometry[1]!.slotLefts[index]!), `column ${index + 1} should align across rows`)
        .toBeLessThan(2);
    });
    for (const row of rowGeometry) {
      const gaps = row.slotLefts.slice(1).map((left, index) => left - row.slotRights[index]!);
      expect(Math.max(...gaps) - Math.min(...gaps), "manual slot gaps should stay fixed across the row")
        .toBeLessThan(2);
    }
    const rowGaps = rowGeometry[0]!.slotLefts.slice(1).map((left, index) => left - rowGeometry[0]!.slotRights[index]!);
    const secondRowGaps = rowGeometry[1]!.slotLefts.slice(1).map((left, index) => left - rowGeometry[1]!.slotRights[index]!);
    expect(rowGaps).toEqual(secondRowGaps);

    const tileMovedToTableId = await page.locator(".rack .tile").first().getAttribute("data-tile-id");
    expect(tileMovedToTableId).not.toBeNull();
    const tileMovedToTableSlot = page.locator(".rack-slot").filter({
      has: page.locator(`.tile[data-tile-id="${tileMovedToTableId}"]`),
    });
    const emptyTargetIndex = await tileMovedToTableSlot.getAttribute("data-rack-slot");
    expect(emptyTargetIndex).not.toBeNull();
    const emptyTarget = page.locator(`.rack-slot[data-rack-slot="${emptyTargetIndex}"]`);
    const draftResponse = page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith(`/api/games/${rackGame.target.session.roomCode}/draft`)
    );
    await page.locator(`.rack .tile[data-tile-id="${tileMovedToTableId}"]`).dblclick();
    expect((await draftResponse).ok()).toBe(true);
    await expect(emptyTarget).toHaveClass(/\bis-empty\b/);

    const sourceSlot = page.locator(".rack-slot.is-occupied").last();
    const sourceSlotIndex = await sourceSlot.getAttribute("data-rack-slot");
    const movedTileId = await sourceSlot.locator(".tile").getAttribute("data-tile-id");
    expect(sourceSlotIndex).not.toBeNull();
    expect(movedTileId).not.toBeNull();
    await dragRackTileToSlot(
      page,
      page.locator(`.rack .tile[data-tile-id="${movedTileId}"]`),
      emptyTarget,
    );
    await expect(emptyTarget.locator(`.tile[data-tile-id="${movedTileId}"]`)).toBeVisible();
    await expect(page.locator(`.rack-slot[data-rack-slot="${sourceSlotIndex}"]`)).toHaveClass(/\bis-empty\b/);

    const occupiedDestination = page.locator(".rack-slot.is-occupied").filter({
      hasNot: page.locator(`.tile[data-tile-id="${movedTileId}"]`),
    }).first();
    const occupiedDestinationIndex = await occupiedDestination.getAttribute("data-rack-slot");
    const displacedTileId = await occupiedDestination.locator(".tile").getAttribute("data-tile-id");
    expect(occupiedDestinationIndex).not.toBeNull();
    expect(displacedTileId).not.toBeNull();
    await dragRackTileToSlot(
      page,
      page.locator(`.rack .tile[data-tile-id="${movedTileId}"]`),
      occupiedDestination,
    );
    await expect(page.locator(`.rack-slot[data-rack-slot="${occupiedDestinationIndex}"] .tile[data-tile-id="${movedTileId}"]`))
      .toBeVisible();
    const pushedSnapshot = await rackSlotSnapshot(page);
    const pushedTileIndex = pushedSnapshot.indexOf(displacedTileId!);
    expect(pushedTileIndex).toBeGreaterThanOrEqual(0);
    expect(pushedTileIndex % 2).toBe(Number(occupiedDestinationIndex) % 2);
    expect(Math.floor(pushedTileIndex / 2)).toBeGreaterThan(Math.floor(Number(occupiedDestinationIndex) / 2));

    await page.getByRole("button", { name: "Reset turn" }).click();
    await expect(page.locator(".meld")).toHaveCount(0);
    await expect(page.locator(`.rack-slot[data-rack-slot="${occupiedDestinationIndex}"] .tile[data-tile-id="${movedTileId}"]`))
      .toBeVisible();

    const manualLayout = await rackSlotSnapshot(page);
    const rackLayoutKey = `guppycube:rack-layout:${rackGame.state.id}:${rackGame.state.myPlayerId}`;
    await expect.poll(async () => {
      const stored = await page.evaluate((key) => localStorage.getItem(key), rackLayoutKey);
      return stored ? (JSON.parse(stored) as { slots: Array<string | null> }).slots : null;
    }).toEqual(manualLayout);

    await page.reload();
    await expect(page.getByText("Your turn", { exact: true })).toBeVisible();
    await expect(page.getByRole("grid", { name: "Your rack, manual arrangement" })).toBeVisible();
    expect(await rackSlotSnapshot(page)).toEqual(manualLayout);

    await colorButton.click();
    await expect(page.getByRole("grid", { name: "Your rack, autosorted" })).toBeVisible();
    await expect(colorButton).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Draw & end" }).click();
    await expect(page.getByText("Your turn", { exact: true })).not.toBeVisible();

    const outOfTurnSource = page.locator(".rack-slot.is-occupied").first();
    const outOfTurnSourceIndex = await outOfTurnSource.getAttribute("data-rack-slot");
    const outOfTurnTile = outOfTurnSource.locator(".tile");
    const outOfTurnTileId = await outOfTurnTile.getAttribute("data-tile-id");
    const farRightTarget = rows.nth(0).locator(":scope > .rack-slot").last();
    const farRightTargetIndex = await farRightTarget.getAttribute("data-rack-slot");
    expect(outOfTurnSourceIndex).not.toBeNull();
    expect(outOfTurnTileId).not.toBeNull();
    expect(farRightTargetIndex).not.toBeNull();
    await expect(outOfTurnTile).toBeEnabled();

    await dragRackTileToSlot(page, outOfTurnTile, farRightTarget);
    await expect(page.locator(`.rack-slot[data-rack-slot="${farRightTargetIndex}"] .tile[data-tile-id="${outOfTurnTileId}"]`))
      .toBeVisible();
    await expect(page.locator(`.rack-slot[data-rack-slot="${outOfTurnSourceIndex}"] .tile[data-tile-id="${outOfTurnTileId}"]`))
      .toHaveCount(0);
    await expect(page.getByRole("grid", { name: "Your rack, manual arrangement" })).toBeVisible();
    await expect(colorButton).toHaveAttribute("aria-pressed", "false");
    await expect(numberButton).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("guppycube:rack-autosort")))
      .toBe("false");

    const outOfTurnLayout = await rackSlotSnapshot(page);
    await expect.poll(async () => {
      const stored = await page.evaluate((key) => localStorage.getItem(key), rackLayoutKey);
      return stored ? (JSON.parse(stored) as { slots: Array<string | null> }).slots : null;
    }).toEqual(outOfTurnLayout);

    await page.reload();
    await expect(page.getByText("Your turn", { exact: true })).not.toBeVisible();
    expect(await rackSlotSnapshot(page)).toEqual(outOfTurnLayout);

    const manualTileIds = outOfTurnLayout.filter((tileId): tileId is string => tileId !== null);
    await colorButton.click();
    await expect(colorButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("grid", { name: "Your rack, autosorted" })).toBeVisible();
    expect(await page.locator(".rack .tile").evaluateAll((tiles) =>
      tiles.map((tile) => (tile as HTMLElement).dataset.tileId),
    )).toEqual(sortRack(manualTileIds, rackGame.state.tiles, "color-first"));

    await numberButton.click();
    await expect(numberButton).toHaveAttribute("aria-pressed", "true");
    expect(await page.locator(".rack .tile").evaluateAll((tiles) =>
      tiles.map((tile) => (tile as HTMLElement).dataset.tileId),
    )).toEqual(sortRack(manualTileIds, rackGame.state.tiles, "number-first"));
    await expect.poll(() => page.evaluate(() => ({
      autosort: localStorage.getItem("guppycube:rack-autosort"),
      mode: localStorage.getItem("guppycube:rack-sort"),
    }))).toEqual({ autosort: "true", mode: "number-first" });
  } finally {
    await context?.close();
    await disposePlayers(rackGame.players);
  }
});

test("double-clicks rack tiles into one newly created meld", async ({ browser }) => {
  test.setTimeout(60_000);
  const rackGame = await createRackGame();
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({ storageState: await rackGame.target.api.storageState() });
    const page = await context.newPage();
    await page.goto(`${appUrl}/room/${rackGame.target.session.roomCode}`);
    await expect(page.getByText("Your turn", { exact: true })).toBeVisible();
    await expect(page.locator(".meld")).toHaveCount(0);

    const [firstTileId, secondTileId] = rackGame.state.myRack;
    expect(firstTileId).toBeDefined();
    expect(secondTileId).toBeDefined();

    await page.locator(`.rack .tile[data-tile-id="${firstTileId}"]`).dblclick();

    const createdMeld = page.locator(".meld").first();
    await expect(createdMeld).toBeVisible();
    await expect(createdMeld.locator(".tile")).toHaveCount(1);
    await expect(createdMeld.locator(`.tile[data-tile-id="${firstTileId}"]`)).toBeVisible();
    await expect(page.locator(".rack .tile")).toHaveCount(rackGame.state.myRack.length - 1);

    await page.locator(`.rack .tile[data-tile-id="${secondTileId}"]`).dblclick();

    await expect(page.locator(".meld")).toHaveCount(1);
    await expect(createdMeld.locator(".tile")).toHaveCount(2);
    const meldTileIds = await createdMeld.locator(".tile").evaluateAll((tiles) =>
      tiles.map((tile) => (tile as HTMLElement).dataset.tileId).sort(),
    );
    expect(meldTileIds).toEqual([firstTileId, secondTileId].sort());
    await expect(page.locator(".rack .tile")).toHaveCount(rackGame.state.myRack.length - 2);
  } finally {
    await context?.close();
    await disposePlayers(rackGame.players);
  }
});

test("supports a complete keyboard turn workflow", async ({ browser }) => {
  test.setTimeout(60_000);
  const rackGame = await createRackGame();
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({ storageState: await rackGame.target.api.storageState() });
    const page = await context.newPage();
    await page.goto(`${appUrl}/room/${rackGame.target.session.roomCode}`);
    await expect(page.getByText("Your turn", { exact: true })).toBeVisible();

    const sortButtonName = rackGame.linked.sortMode === "color-first" ? "Color → 123" : "123 → Color";
    await page.getByRole("button", { name: sortButtonName }).click();

    await expect(page.getByRole("button", { name: "Focus tiles", exact: true })).toHaveCount(0);
    await expect(page.getByText("Your rack", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Start here, then arrows move · Space selects", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: sortButtonName }).focus();
    await page.keyboard.press("ArrowRight");
    const firstDisplayedTile = page.locator(".rack .tile").first();
    await expect(firstDisplayedTile).toBeFocused();
    await expect(page.locator(".game-shell")).toHaveClass(/is-keyboard-navigating/);
    await page.keyboard.press("Space");
    await expect(firstDisplayedTile).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByText("Space selects in yellow", { exact: true })).toHaveCount(0);

    const heldTile = page.locator(`.rack .tile[data-tile-id="${rackGame.linked.heldId}"]`);
    await heldTile.focus();
    await page.keyboard.press("Shift+Enter");
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(rackGame.linked.tileIds.length);

    await page.keyboard.press("Alt+Enter");
    await expect(page.locator(".meld")).toHaveCount(1);
    await expect(page.locator(".meld .tile")).toHaveCount(rackGame.linked.tileIds.length);

    await page.keyboard.press("Control+z");
    await expect(page.locator(".meld")).toHaveCount(0);
    await expect(page.locator(".rack .tile")).toHaveCount(rackGame.state.myRack.length);

    const [firstTileId, secondTileId] = rackGame.linked.sortedRack;
    expect(firstTileId).toBeDefined();
    expect(secondTileId).toBeDefined();
    const firstTile = page.locator(`.rack .tile[data-tile-id="${firstTileId}"]`);
    await firstTile.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(firstTile).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`.rack .tile[data-tile-id="${secondTileId}"]`)).toBeFocused();
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(0);

    await firstTile.focus();
    await page.keyboard.press("Control+a");
    await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(rackGame.state.myRack.length);
    await page.keyboard.press("Escape");

    await firstTile.focus();
    await page.keyboard.press("Alt+Enter");
    await page.locator(`.rack .tile[data-tile-id="${secondTileId}"]`).focus();
    await page.keyboard.press("Alt+Enter");
    await expect(page.locator(".meld")).toHaveCount(2);

    const firstMeldMove = page.locator(".meld-drag-handle").first();
    await expect(firstMeldMove).toHaveAccessibleName("Pick up meld 1");
    await firstMeldMove.focus();
    await page.keyboard.press("Enter");
    await expect(firstMeldMove).toHaveAttribute("aria-pressed", "true");
    const secondMeldMove = page.getByRole("button", { name: "Combine picked-up meld with meld 2" });
    await secondMeldMove.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".meld")).toHaveCount(1);
    await expect(page.locator(".meld .tile")).toHaveCount(2);

    await page.getByRole("button", { name: "Reset turn" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".meld")).toHaveCount(0);

    const commitButton = page.getByRole("button", { name: "Commit turn" });
    const drawButton = page.getByRole("button", { name: "Draw & end" });
    await expect(commitButton).toHaveAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
    await expect(drawButton).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Enter Meta+Shift+Enter");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByText(/Turn not ready\./)).toBeAttached();

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Meta+Shift+Enter");
    await expect(page.getByText("Your turn", { exact: true })).not.toBeVisible();
  } finally {
    await context?.close();
    await disposePlayers(rackGame.players);
  }
});
