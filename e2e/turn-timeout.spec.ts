import {
  expect,
  test,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import type { Meld, PublicGameState, Tile } from "../src/schemas";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");

type GameState = PublicGameState;

interface PlayingGame {
  roomCode: string;
  hostContext: BrowserContext;
  guestContext: BrowserContext;
}

interface CurrentSeat {
  context: BrowserContext;
  otherContext: BrowserContext;
  state: GameState;
}

interface OpeningMove {
  melds: Meld[];
  points: number;
}

async function getGame(context: BrowserContext, roomCode: string): Promise<GameState> {
  const response = await context.request.get(`${appUrl}/api/games/${roomCode}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<GameState>;
}

async function createPlayingGame(browser: Browser, suffix: string): Promise<PlayingGame> {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const createResponse = await hostContext.request.post(`${appUrl}/api/games`, {
      headers: { "X-Guppycube-Turn-Duration-Ms": "15000" },
      data: {
        name: `Host ${suffix}`,
        mode: "realtime",
        maxPlayers: 2,
        assistPolicy: {
          "no-move-alert": "disallowed",
          "auto-draw": "disallowed",
          "rack-meld-highlights": "disallowed",
        },
      },
    });
    expect(createResponse.status()).toBe(201);
    const { roomCode } = await createResponse.json() as { roomCode: string };

    const joinResponse = await guestContext.request.post(`${appUrl}/api/games/${roomCode}/join`, {
      data: { name: `Guest ${suffix}` },
    });
    expect(joinResponse.status()).toBe(201);

    const startResponse = await hostContext.request.post(`${appUrl}/api/games/${roomCode}/start`, {
      data: {},
    });
    expect(startResponse.ok()).toBe(true);
    return { roomCode, hostContext, guestContext };
  } catch (error) {
    await Promise.all([hostContext.close(), guestContext.close()]);
    throw error;
  }
}

async function currentSeat(game: PlayingGame): Promise<CurrentSeat> {
  const [hostState, guestState] = await Promise.all([
    getGame(game.hostContext, game.roomCode),
    getGame(game.guestContext, game.roomCode),
  ]);
  expect(hostState.currentPlayerId).not.toBeNull();
  if (hostState.myPlayerId === hostState.currentPlayerId) {
    return { context: game.hostContext, otherContext: game.guestContext, state: hostState };
  }
  expect(guestState.myPlayerId).toBe(hostState.currentPlayerId);
  return { context: game.guestContext, otherContext: game.hostContext, state: guestState };
}

function timeoutBudget(state: GameState): number {
  expect(state.turnDeadline).not.toBeNull();
  return Math.max(20_000, state.turnDeadline! - Date.now() + 20_000);
}

async function waitForTurnEnd(
  context: BrowserContext,
  roomCode: string,
  state: GameState,
): Promise<GameState> {
  let observed = state;
  await expect.poll(async () => {
    observed = await getGame(context, roomCode);
    return observed.currentPlayerId;
  }, {
    message: `turn ${state.turnStartedAt} should end after its deadline`,
    timeout: timeoutBudget(state),
    intervals: [250, 500, 1_000],
  }).not.toBe(state.currentPlayerId);
  return observed;
}

function orderedMeld(tileIds: string[], tiles: Record<string, Tile>): { tileIds: string[]; points: number } | null {
  const selected = tileIds.map((id) => tiles[id]);
  if (selected.some((tile) => !tile)) return null;
  const numbered = selected.filter((tile): tile is Tile => Boolean(tile && !tile.wildcard));
  const wildcards = selected.filter((tile): tile is Tile => Boolean(tile?.wildcard));
  if (numbered.length === 0) return null;

  if (selected.length === 3 || selected.length === 4) {
    const value = numbered[0]!.value;
    const colors = numbered.map((tile) => tile.color);
    if (
      value !== null
      && numbered.every((tile) => tile.value === value)
      && colors.every((color) => color !== null)
      && new Set(colors).size === colors.length
    ) {
      return { tileIds, points: value * selected.length };
    }
  }

  if (selected.length < 3 || selected.length > 13) return null;
  const color = numbered[0]!.color;
  const values = numbered.map((tile) => tile.value);
  if (
    color === null
    || numbered.some((tile) => tile.color !== color)
    || values.some((value) => value === null)
    || new Set(values).size !== values.length
  ) return null;

  for (let start = 1; start <= 14 - selected.length; start += 1) {
    const ordered: Array<string | undefined> = Array.from({ length: selected.length });
    let fits = true;
    for (const tile of numbered) {
      const index = tile.value! - start;
      if (index < 0 || index >= selected.length || ordered[index]) {
        fits = false;
        break;
      }
      ordered[index] = tile.id;
    }
    if (!fits) continue;
    const availableWildcards = [...wildcards];
    for (let index = 0; index < ordered.length; index += 1) {
      if (!ordered[index]) ordered[index] = availableWildcards.shift()?.id;
    }
    if (ordered.some((id) => !id) || availableWildcards.length > 0) continue;
    const end = start + selected.length - 1;
    return {
      tileIds: ordered as string[],
      points: (selected.length * (start + end)) / 2,
    };
  }
  return null;
}

function findOpeningMove(state: GameState): OpeningMove | null {
  const rack = state.myRack;
  const candidates: Array<{ mask: number; tileIds: string[]; points: number }> = [];
  for (let mask = 1; mask < 1 << rack.length; mask += 1) {
    const tileIds = rack.filter((_, index) => (mask & (1 << index)) !== 0);
    if (tileIds.length < 3 || tileIds.length > 13) continue;
    const meld = orderedMeld(tileIds, state.tiles);
    if (meld) candidates.push({ mask, ...meld });
  }

  const search = (
    start: number,
    usedMask: number,
    points: number,
    melds: Meld[],
  ): OpeningMove | null => {
    if (points >= 30) return { melds, points };
    for (let index = start; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      if ((candidate.mask & usedMask) !== 0) continue;
      const result = search(index + 1, usedMask | candidate.mask, points + candidate.points, [
        ...melds,
        { id: `timeout-opening-${melds.length + 1}`, tileIds: candidate.tileIds },
      ]);
      if (result) return result;
    }
    return null;
  };

  return search(0, 0, 0, []);
}

async function gameWithOpeningMove(browser: Browser): Promise<{
  game: PlayingGame;
  seat: CurrentSeat;
  opening: OpeningMove;
}> {
  const game = await createPlayingGame(browser, `valid-${Date.now().toString(36).slice(-6)}`);
  try {
    for (let turn = 0; turn < 12; turn += 1) {
      const seat = await currentSeat(game);
      const opening = findOpeningMove(seat.state);
      if (opening) return { game, seat, opening };

      const drawResponse = await seat.context.request.post(`${appUrl}/api/games/${game.roomCode}/action`, {
        data: { action: { type: "draw" } },
      });
      expect(drawResponse.ok()).toBe(true);
    }
    throw new Error("Could not deal a live current-player rack with a valid 30-point opening in 12 turns.");
  } catch (error) {
    await Promise.all([game.hostContext.close(), game.guestContext.close()]);
    throw error;
  }
}

test.describe.configure({ mode: "parallel" });

test("timeout draws a tile when the player made no play", async ({ browser }) => {
  test.setTimeout(200_000);
  const game = await createPlayingGame(browser, `idle-${Date.now().toString(36).slice(-6)}`);
  try {
    const seat = await currentSeat(game);
    expect(seat.state.myTurnDraft).toBeNull();
    const page = await seat.context.newPage();
    await page.goto(`${appUrl}/room/${game.roomCode}`);
    await expect(page.getByText("Your turn", { exact: true })).toBeVisible();

    const after = await waitForTurnEnd(seat.context, game.roomCode, seat.state);

    expect(after.board).toEqual(seat.state.board);
    expect(after.myRack).toHaveLength(seat.state.myRack.length + 1);
    expect(after.myRack).toEqual(expect.arrayContaining(seat.state.myRack));
    expect(after.poolCount).toBe(seat.state.poolCount - 1);
    expect(after.myTurnDraft).toBeNull();
    expect(after.history.at(-1)).toEqual(expect.objectContaining({
      kind: "timeout",
      playerId: seat.state.myPlayerId,
      message: expect.stringContaining("clock ran out"),
    }));
    const nextPlayer = after.players.find((player) => player.id === after.currentPlayerId);
    await expect(page.locator(".turn-clock small")).toHaveText(`${nextPlayer!.name}'s turn`);
  } finally {
    await Promise.all([game.hostContext.close(), game.guestContext.close()]);
  }
});

test("timeout accepts a valid synchronized draft as the submitted turn", async ({ browser }) => {
  test.setTimeout(200_000);
  const { game, seat, opening } = await gameWithOpeningMove(browser);
  try {
    expect(seat.state.board).toEqual([]);
    expect(seat.state.turnStartedAt).not.toBeNull();
    const saveResponse = await seat.context.request.put(`${appUrl}/api/games/${game.roomCode}/draft`, {
      data: {
        turnStartedAt: seat.state.turnStartedAt,
        sequence: Date.now(),
        board: opening.melds,
      },
    });
    expect(saveResponse.ok()).toBe(true);

    const [savedForPlayer, hiddenFromOpponent] = await Promise.all([
      getGame(seat.context, game.roomCode),
      getGame(seat.otherContext, game.roomCode),
    ]);
    expect(savedForPlayer.myTurnDraft).toEqual(opening.melds);
    expect(savedForPlayer.board).toEqual([]);
    expect(hiddenFromOpponent.myTurnDraft).toBeNull();

    const playedTileIds = opening.melds.flatMap((meld) => meld.tileIds);
    const page = await seat.context.newPage();
    await page.goto(`${appUrl}/room/${game.roomCode}`);
    await expect(page.locator(".meld.is-valid")).toHaveCount(opening.melds.length);
    await expect(page.locator(".table-summary b")).toHaveText(`${playedTileIds.length} tiles down`);
    await expect(page.locator(".rack .tile")).toHaveCount(seat.state.myRack.length - playedTileIds.length);
    await expect(page.getByRole("button", { name: /Commit turn/ })).toBeEnabled();

    const after = await waitForTurnEnd(seat.context, game.roomCode, savedForPlayer);

    expect(after.board.map((meld) => meld.tileIds)).toEqual(opening.melds.map((meld) => meld.tileIds));
    expect([...after.myRack].sort()).toEqual(
      seat.state.myRack.filter((tileId) => !playedTileIds.includes(tileId)).sort(),
    );
    expect(after.poolCount).toBe(seat.state.poolCount);
    expect(after.myTurnDraft).toBeNull();
    expect(after.history.at(-1)).toEqual(expect.objectContaining({
      kind: "played",
      playerId: seat.state.myPlayerId,
    }));
    await expect(page.locator(".table-summary b")).toHaveText(`${playedTileIds.length} tiles down`);
  } finally {
    await Promise.all([game.hostContext.close(), game.guestContext.close()]);
  }
});

test("timeout discards an invalid UI-synchronized draft and draws a tile", async ({ browser }) => {
  test.setTimeout(200_000);
  const game = await createPlayingGame(browser, `invalid-${Date.now().toString(36).slice(-6)}`);
  try {
    const seat = await currentSeat(game);
    expect(seat.state.board).toEqual([]);
    const tileId = seat.state.myRack[0]!;
    const page = await seat.context.newPage();
    await page.goto(`${appUrl}/room/${game.roomCode}`);
    await expect(page.getByText("Your turn", { exact: true })).toBeVisible();

    const draftResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith(`/api/games/${game.roomCode}/draft`)
    );
    await page.locator(`.rack .tile[data-tile-id="${tileId}"]`).dblclick();
    expect((await draftResponsePromise).ok()).toBe(true);
    await expect(page.locator(".meld.is-invalid")).toHaveCount(1);
    await expect(page.locator(".meld-status")).toHaveText("unfinished");

    const [savedForPlayer, hiddenFromOpponent] = await Promise.all([
      getGame(seat.context, game.roomCode),
      getGame(seat.otherContext, game.roomCode),
    ]);
    expect(savedForPlayer.board).toEqual([]);
    expect(savedForPlayer.myTurnDraft).toEqual([
      expect.objectContaining({ tileIds: [tileId] }),
    ]);
    expect(hiddenFromOpponent.myTurnDraft).toBeNull();

    await page.reload();
    await expect(page.locator(".meld.is-invalid")).toHaveCount(1);
    await expect(page.locator(`.meld .tile[data-tile-id="${tileId}"]`)).toBeVisible();
    await expect(page.locator(".rack .tile")).toHaveCount(seat.state.myRack.length - 1);

    const after = await waitForTurnEnd(seat.context, game.roomCode, savedForPlayer);

    expect(after.board).toEqual([]);
    expect(after.myRack).toHaveLength(seat.state.myRack.length + 1);
    expect(after.myRack).toEqual(expect.arrayContaining(seat.state.myRack));
    expect(after.poolCount).toBe(seat.state.poolCount - 1);
    expect(after.myTurnDraft).toBeNull();
    expect(after.history.at(-1)).toEqual(expect.objectContaining({
      kind: "timeout",
      playerId: seat.state.myPlayerId,
    }));
    await expect(page.locator(".meld")).toHaveCount(0);
    await expect(page.locator(".rack .tile")).toHaveCount(seat.state.myRack.length + 1);
  } finally {
    await Promise.all([game.hostContext.close(), game.guestContext.close()]);
  }
});
