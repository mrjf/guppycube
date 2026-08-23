import { expect, test, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const roomCode = "amber-cactus-trumpet";
const targetPlayerId = "player-unopened";
const otherPlayerId = "player-opened";
const existingRun = ["ink-8-1", "ink-9-1", "ink-10-1"];
const extenderId = "ink-11-1";
const rackOpening = ["coral-10-1", "coral-11-1", "coral-12-1"];
const rackFillers = ["sun-1-1", "ocean-2-1", "sun-5-1"];

interface Meld {
  id: string;
  tileIds: string[];
}

interface PlayerState {
  id: string;
  name: string;
  rackCount: number;
  rackTileIds: string[];
  opened: boolean;
  connected: boolean;
  isHost: boolean;
  isComputer: boolean;
  computerStrategy: null;
}

interface GameState {
  id: string;
  version: number;
  mode: "realtime";
  status: "playing";
  maxPlayers: 2;
  createdAt: number;
  updatedAt: number;
  turnStartedAt: number;
  turnDeadline: number;
  currentPlayerId: string;
  winnerId: null;
  poolCount: number;
  board: Meld[];
  players: PlayerState[];
  myPlayerId: string;
  myRack: string[];
  turnDraft: Meld[] | null;
  myTurnDraft: Meld[] | null;
  tiles: Record<string, {
    id: string;
    color: "coral" | "sun" | "ocean" | "ink";
    value: number;
    wildcard: false;
  }>;
  history: Array<{
    id: string;
    at: number;
    playerId: string | null;
    kind: "started" | "played";
    message: string;
  }>;
  scores: null;
  assistPolicy: {
    "no-move-alert": "default-on";
    "auto-draw": "default-off";
    "rack-meld-highlights": "default-off";
  };
  enabledAssists: string[];
  noMovePossible: boolean;
}

interface MockController {
  actionBodies: Array<{ action: { type: "commit"; board: Meld[] } }>;
  draftBodies: unknown[];
  state: () => GameState;
}

function tile(id: string, color: "coral" | "sun" | "ocean" | "ink", value: number) {
  return { id, color, value, wildcard: false as const };
}

function initialState(): GameState {
  const now = Date.now();
  const allTiles = [
    tile("ink-8-1", "ink", 8),
    tile("ink-9-1", "ink", 9),
    tile("ink-10-1", "ink", 10),
    tile("ink-11-1", "ink", 11),
    tile("coral-10-1", "coral", 10),
    tile("coral-11-1", "coral", 11),
    tile("coral-12-1", "coral", 12),
    tile("sun-1-1", "sun", 1),
    tile("ocean-2-1", "ocean", 2),
    tile("sun-5-1", "sun", 5),
  ];
  const myRack = [extenderId, ...rackOpening, ...rackFillers];
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
    currentPlayerId: targetPlayerId,
    winnerId: null,
    poolCount: 42,
    board: [{ id: "meld-existing", tileIds: existingRun }],
    players: [
      {
        id: targetPlayerId,
        name: "Unopened player",
        rackCount: myRack.length,
        rackTileIds: myRack,
        opened: false,
        connected: true,
        isHost: true,
        isComputer: false,
        computerStrategy: null,
      },
      {
        id: otherPlayerId,
        name: "Opened player",
        rackCount: 14,
        rackTileIds: [],
        opened: true,
        connected: true,
        isHost: false,
        isComputer: false,
        computerStrategy: null,
      },
    ],
    myPlayerId: targetPlayerId,
    myRack,
    turnDraft: null,
    myTurnDraft: null,
    tiles: Object.fromEntries(allTiles.map((entry) => [entry.id, entry])),
    history: [
      {
        id: "event-started",
        at: now - 50_000,
        playerId: null,
        kind: "started",
        message: "Opened player goes first.",
      },
      {
        id: "event-existing-play",
        at: now - 20_000,
        playerId: otherPlayerId,
        kind: "played",
        message: "Opened player played 3 tiles and opened with 27.",
      },
    ],
    scores: null,
    assistPolicy: {
      "no-move-alert": "default-on",
      "auto-draw": "default-off",
      "rack-meld-highlights": "default-off",
    },
    enabledAssists: [],
    noMovePossible: false,
  };
}

async function openControlledGame(page: Page): Promise<MockController> {
  let state = initialState();
  const actionBodies: MockController["actionBodies"] = [];
  const draftBodies: unknown[] = [];

  await page.routeWebSocket(`**/api/games/${roomCode}/ws`, () => {
    // Keep the live client socket open without allowing an unrelated room to
    // replace the deterministic HTTP state used by this interaction test.
  });
  await page.route(`**/api/games/${roomCode}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
  });
  await page.route(`**/api/games/${roomCode}/draft`, async (route) => {
    draftBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(`**/api/games/${roomCode}/action`, async (route) => {
    const body = route.request().postDataJSON() as MockController["actionBodies"][number];
    actionBodies.push(body);
    const playedIds = new Set(
      body.action.board.flatMap((meld) => meld.tileIds).filter((tileId) => !existingRun.includes(tileId)),
    );
    state = {
      ...state,
      version: state.version + 1,
      updatedAt: Date.now(),
      currentPlayerId: otherPlayerId,
      board: body.action.board,
      myRack: state.myRack.filter((tileId) => !playedIds.has(tileId)),
      players: state.players.map((player) => player.id === targetPlayerId
        ? { ...player, opened: true, rackCount: player.rackCount - playedIds.size }
        : player),
      history: [...state.history, {
        id: "event-mixed-opening",
        at: Date.now(),
        playerId: targetPlayerId,
        kind: "played",
        message: "Unopened player played 4 tiles and opened with 33.",
      }],
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  const mainResponse = await page.goto(`${appUrl}/room/${roomCode}`);
  expect(mainResponse?.ok()).toBe(true);
  await expect(page.getByLabel("Game table")).toBeVisible();
  await expect(page.getByText("Your turn", { exact: true })).toBeVisible();
  await expect(page.getByText("Opening meld: 0 / 30", { exact: true })).toBeVisible();
  return { actionBodies, draftBodies, state: () => structuredClone(state) };
}

async function placeRackMeld(page: Page, tileIds: string[]): Promise<void> {
  const meldCount = await page.locator(".meld").count();
  for (const tileId of tileIds) {
    const rackTile = page.locator(`.rack .tile[data-tile-id="${tileId}"]`);
    await rackTile.focus();
    await rackTile.press("Space");
  }
  await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(tileIds.length);
  await page.locator(`.rack .tile[data-tile-id="${tileIds.at(-1)!}"]`).press("Alt+Enter");
  await expect(page.locator(".meld")).toHaveCount(meldCount + 1);
  await expect(page.locator(".meld").last()).toHaveClass(/\bis-valid\b/);
}

async function extendExistingRun(page: Page): Promise<void> {
  const existingMeld = page.locator(".meld").filter({
    has: page.locator(`.tile[data-tile-id="${existingRun[0]}"]`),
  });
  const extender = page.locator(`.rack .tile[data-tile-id="${extenderId}"]`);
  await extender.focus();
  await extender.press("Space");
  await existingMeld.locator(".meld-status").click();
  await expect(existingMeld.locator(`.tile[data-tile-id="${extenderId}"]`)).toBeVisible();
  await expect(existingMeld).toHaveClass(/\bis-valid\b/);
}

test("blocks a table-only extension because it contributes zero rack-only opening points", async ({ page }) => {
  const controlled = await openControlledGame(page);
  await extendExistingRun(page);

  await expect(page.locator(".meld.is-invalid")).toHaveCount(0);
  await expect(page.getByText("Opening meld: 0 / 30", { exact: true })).toBeVisible();
  const reason = "Your opening melds total 0; you need at least 30.";
  await expect(page.locator(".turn-guidance")).toHaveText(reason);
  await expect(page.getByRole("button", { name: "Commit turn" })).toBeDisabled();

  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".sr-only")).toHaveText(`Turn not ready. ${reason}`);
  expect(controlled.actionBodies).toEqual([]);
  expect(controlled.draftBodies).toHaveLength(1);
  expect(controlled.state().players.find((player) => player.id === targetPlayerId)?.opened).toBe(false);
  expect(controlled.state().board).toEqual([{ id: "meld-existing", tileIds: existingRun }]);
});

test("enables and submits a 30-plus rack-only opening that also extends an existing table run", async ({ page }) => {
  const controlled = await openControlledGame(page);
  await placeRackMeld(page, rackOpening);
  await extendExistingRun(page);

  await expect(page.locator(".meld.is-invalid")).toHaveCount(0);
  await expect(page.getByText("Opening meld: 33 / 30", { exact: true })).toBeVisible();
  await expect(page.locator(".turn-guidance")).toHaveText("Your play is ready to commit.");
  const commitButton = page.getByRole("button", { name: "Commit turn" });
  await expect(commitButton).toBeEnabled();

  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith(`/api/games/${roomCode}/action`),
  );
  await commitButton.click();
  expect((await responsePromise).ok()).toBe(true);
  await expect(page.getByText("Your turn", { exact: true })).toHaveCount(0);

  expect(controlled.actionBodies).toHaveLength(1);
  const submittedBoard = controlled.actionBodies[0]!.action.board;
  expect(submittedBoard).toHaveLength(2);
  expect(submittedBoard.flatMap((meld) => meld.tileIds).sort()).toEqual([
    ...existingRun,
    extenderId,
    ...rackOpening,
  ].sort());
  expect(controlled.draftBodies).toHaveLength(2);
  const committed = controlled.state();
  expect(committed.players.find((player) => player.id === targetPlayerId)?.opened).toBe(true);
  expect(committed.myRack).toEqual(rackFillers);
  expect(committed.currentPlayerId).toBe(otherPlayerId);
});
