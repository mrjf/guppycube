import {
  expect,
  test,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";
import type { PublicGameState, Tile, TileColor } from "../src/schemas";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const roomCode = "copper-comet-piano";
const viewerId = "player-viewer";
const remotePlayerId = "player-remote";
const initialBoardTileIds = ["coral-7-1", "sun-7-1", "ocean-7-1"];
const remotelyPlayedTileIds = ["ink-8-1", "ink-9-1", "ink-10-1"];
const locallyCommittedTileIds = ["sun-10-1", "sun-11-1", "sun-12-1"];
const localDraftTileId = "coral-2-1";

interface ControlledGame {
  initialState: PublicGameState;
  sendState: (state: PublicGameState) => void;
}

function numberedTile(id: string): Tile {
  const [color, value] = id.split("-");
  return {
    id,
    color: color as TileColor,
    value: Number(value),
    joker: false,
  };
}

function createState(remoteIsComputer: boolean): PublicGameState {
  const now = Date.now();
  const tileIds = [
    ...initialBoardTileIds,
    ...remotelyPlayedTileIds,
    ...locallyCommittedTileIds,
    localDraftTileId,
    "ocean-1-1",
  ];
  const tiles = Object.fromEntries(tileIds.map((tileId) => [tileId, numberedTile(tileId)]));
  const myRack = [localDraftTileId, ...locallyCommittedTileIds, "ocean-1-1"];
  const remoteName = remoteIsComputer ? "Guppy Bot" : "Remote player";

  return {
    id: roomCode,
    version: 7,
    mode: "realtime",
    status: "playing",
    maxPlayers: 2,
    createdAt: now - 60_000,
    updatedAt: now,
    turnStartedAt: now,
    turnDeadline: now + 120_000,
    currentPlayerId: viewerId,
    winnerId: null,
    poolCount: 80,
    board: [{ id: "meld-initial", tileIds: initialBoardTileIds }],
    players: [
      {
        id: viewerId,
        name: "Viewing player",
        rackCount: myRack.length,
        rackTileIds: myRack,
        opened: true,
        connected: true,
        isHost: true,
        isComputer: false,
        computerStrategy: null,
      },
      {
        id: remotePlayerId,
        name: remoteName,
        rackCount: 14,
        rackTileIds: [],
        opened: true,
        connected: true,
        isHost: false,
        isComputer: remoteIsComputer,
        computerStrategy: remoteIsComputer ? "basic" : null,
      },
    ],
    myPlayerId: viewerId,
    myRack,
    myTurnDraft: null,
    tiles,
    history: [
      {
        id: "event-started",
        at: now - 50_000,
        playerId: null,
        kind: "started",
        message: "Viewing player goes first.",
      },
      {
        id: "event-before-load",
        at: now - 20_000,
        playerId: remotePlayerId,
        kind: "played",
        message: `${remoteName} played 3 tiles.`,
      },
    ],
    scores: null,
    assistPolicy: {
      "no-move-alert": "default-on",
      "auto-draw": "default-off",
    },
    enabledAssists: [],
    noMovePossible: false,
  };
}

async function openControlledGame(page: Page, remoteIsComputer: boolean): Promise<ControlledGame> {
  const initialState = createState(remoteIsComputer);
  let socket: WebSocketRoute | undefined;

  await page.routeWebSocket(`**/api/games/${roomCode}/ws`, (route) => {
    socket = route;
  });
  await page.route(`**/api/games/${roomCode}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(initialState),
    });
  });
  await page.route(`**/api/games/${roomCode}/draft`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  }));

  const response = await page.goto(`${appUrl}/room/${roomCode}`);
  expect(response?.ok()).toBe(true);
  await expect(page.getByLabel("Game table")).toBeVisible();
  await expect(page.locator(".connection-pill")).toContainText("online");
  expect(socket, "the controlled game WebSocket should be connected").toBeDefined();

  return {
    initialState,
    sendState: (state) => socket!.send(JSON.stringify({ type: "state", state })),
  };
}

function stateWithRemoteTurn(initialState: PublicGameState): PublicGameState {
  const now = Date.now();
  return {
    ...initialState,
    version: initialState.version + 1,
    updatedAt: now,
    turnStartedAt: now,
    turnDeadline: now + 120_000,
    currentPlayerId: remotePlayerId,
  };
}

function stateWithRemotePlay(remoteTurn: PublicGameState): PublicGameState {
  const now = Date.now();
  const remoteName = remoteTurn.players.find((player) => player.id === remotePlayerId)!.name;
  return {
    ...remoteTurn,
    version: remoteTurn.version + 1,
    updatedAt: now,
    turnStartedAt: now,
    turnDeadline: now + 120_000,
    currentPlayerId: viewerId,
    board: [
      ...remoteTurn.board,
      { id: "meld-remote", tileIds: remotelyPlayedTileIds },
    ],
    players: remoteTurn.players.map((player) => player.id === remotePlayerId
      ? { ...player, rackCount: player.rackCount - remotelyPlayedTileIds.length }
      : player),
    history: [
      ...remoteTurn.history,
      {
        id: "event-live-remote-play",
        at: now,
        playerId: remotePlayerId,
        kind: "played",
        message: `${remoteName} played 3 tiles.`,
      },
    ],
  };
}

function stateWithLocalCommit(remotePlay: PublicGameState): PublicGameState {
  const now = Date.now();
  return {
    ...remotePlay,
    version: remotePlay.version + 1,
    updatedAt: now,
    turnStartedAt: now,
    turnDeadline: now + 120_000,
    currentPlayerId: remotePlayerId,
    board: [
      ...remotePlay.board,
      { id: "meld-local", tileIds: locallyCommittedTileIds },
    ],
    players: remotePlay.players.map((player) => player.id === viewerId
      ? { ...player, rackCount: player.rackCount - locallyCommittedTileIds.length }
      : player),
    myRack: remotePlay.myRack.filter((tileId) => !locallyCommittedTileIds.includes(tileId)),
    history: [
      ...remotePlay.history,
      {
        id: "event-live-local-play",
        at: now,
        playerId: viewerId,
        kind: "played",
        message: "Viewing player played 3 tiles.",
      },
    ],
  };
}

for (const remotePlayer of [
  { label: "Guppy Bot", isComputer: true },
  { label: "another user", isComputer: false },
] as const) {
  test(`fades in only tiles newly played by ${remotePlayer.label}`, async ({ page }) => {
    const controlled = await openControlledGame(page, remotePlayer.isComputer);
    const tableTiles = page.locator(".table-surface .tile");

    await expect(tableTiles).toHaveCount(initialBoardTileIds.length);
    await expect(page.locator(".tile.is-remote-play")).toHaveCount(0);
    await expect(page.locator(".player-action-flash")).toHaveCount(0);

    await page.locator(`.rack .tile[data-tile-id="${localDraftTileId}"]`).dblclick();
    const locallyDraftedTile = page.locator(`.table-surface .tile[data-tile-id="${localDraftTileId}"]`);
    await expect(locallyDraftedTile).toBeVisible();
    await expect(locallyDraftedTile).not.toHaveClass(/\bis-remote-play\b/);
    await expect(page.locator(".tile.is-remote-play")).toHaveCount(0);
    await page.getByRole("button", { name: "Reset turn" }).click();
    await expect(locallyDraftedTile).toHaveCount(0);

    const remoteTurn = stateWithRemoteTurn(controlled.initialState);
    controlled.sendState(remoteTurn);
    const remoteName = remoteTurn.players.find((player) => player.id === remotePlayerId)!.name;
    await expect(page.locator(".turn-clock small")).toHaveText(`${remoteName}'s turn`);
    await expect(page.locator(".tile.is-remote-play")).toHaveCount(0);

    const remotePlay = stateWithRemotePlay(remoteTurn);
    controlled.sendState(remotePlay);
    const animatedTiles = page.locator(".table-surface .tile.is-remote-play");
    await expect(tableTiles).toHaveCount(initialBoardTileIds.length + remotelyPlayedTileIds.length);
    await expect(animatedTiles).toHaveCount(remotelyPlayedTileIds.length);
    for (const tileId of remotelyPlayedTileIds) {
      await expect(page.locator(`.table-surface .tile.is-remote-play[data-tile-id="${tileId}"]`)).toBeVisible();
    }
    for (const tileId of initialBoardTileIds) {
      await expect(page.locator(`.table-surface .tile[data-tile-id="${tileId}"]`)).not.toHaveClass(/\bis-remote-play\b/);
    }
    expect(await animatedTiles.first().evaluate((tile) => ({
      name: getComputedStyle(tile).animationName,
      duration: getComputedStyle(tile).animationDuration,
    }))).toEqual({ name: "remote-play-fade-in", duration: "1.15s" });

    controlled.sendState(stateWithLocalCommit(remotePlay));
    await expect(tableTiles).toHaveCount(
      initialBoardTileIds.length + remotelyPlayedTileIds.length + locallyCommittedTileIds.length,
    );
    for (const tileId of locallyCommittedTileIds) {
      const locallyCommittedTile = page.locator(`.table-surface .tile[data-tile-id="${tileId}"]`);
      await expect(locallyCommittedTile).toBeVisible();
      await expect(locallyCommittedTile).not.toHaveClass(/\bis-remote-play\b/);
    }
  });
}
