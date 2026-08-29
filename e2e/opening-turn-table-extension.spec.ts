import { expect, test, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const roomCode = "amber-cactus-trumpet";
const targetPlayerId = "player-unopened";
const otherPlayerId = "player-opened";
const existingRun = ["ink-8-1", "ink-9-1", "ink-10-1"];
const extenderId = "ink-11-1";
const rackOpening = ["coral-10-1", "coral-11-1", "coral-12-1"];
const rackFillers = ["sun-1-1", "ocean-2-1", "sun-5-1"];

interface GameSet {
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
  board: GameSet[];
  players: PlayerState[];
  myPlayerId: string;
  myRack: string[];
  turnDraft: GameSet[] | null;
  myTurnDraft: GameSet[] | null;
  tiles: Record<string, {
    id: string;
    color: "coral" | "sun" | "ocean" | "ink";
    value: number;
    wilcard: false;
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
    "rack-set-highlights": "default-off";
  };
  enabledAssists: string[];
  noMovePossible: boolean;
}

interface MockController {
  actionBodies: Array<{ action: { type: "commit"; board: GameSet[] } }>;
  draftBodies: unknown[];
  state: () => GameState;
}

function tile(id: string, color: "coral" | "sun" | "ocean" | "ink", value: number) {
  return { id, color, value, wilcard: false as const };
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
    board: [{ id: "set-existing", tileIds: existingRun }],
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
      "rack-set-highlights": "default-off",
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
      body.action.board.flatMap((set) => set.tileIds).filter((tileId) => !existingRun.includes(tileId)),
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
  await expect(page.getByText("Opening set: 0 / 30", { exact: true })).toBeVisible();
  return { actionBodies, draftBodies, state: () => structuredClone(state) };
}

async function placeRackSet(page: Page, tileIds: string[]): Promise<void> {
  const setCount = await page.locator(".set").count();
  for (const tileId of tileIds) {
    const rackTile = page.locator(`.rack .tile[data-tile-id="${tileId}"]`);
    await rackTile.focus();
    await rackTile.press("Space");
  }
  await expect(page.locator('.rack .tile[aria-pressed="true"]')).toHaveCount(tileIds.length);
  await page.locator(`.rack .tile[data-tile-id="${tileIds.at(-1)!}"]`).press("Alt+Enter");
  await expect(page.locator(".set")).toHaveCount(setCount + 1);
  await expect(page.locator(".set").last()).toHaveClass(/\bis-valid\b/);
}

async function extendExistingRun(page: Page): Promise<void> {
  const existingSet = page.locator(".set").filter({
    has: page.locator(`.tile[data-tile-id="${existingRun[0]}"]`),
  });
  const extender = page.locator(`.rack .tile[data-tile-id="${extenderId}"]`);
  await extender.focus();
  await extender.press("Space");
  await existingSet.evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(existingSet.locator(`.tile[data-tile-id="${extenderId}"]`)).toBeVisible();
  await expect(existingSet).toHaveClass(/\bis-valid\b/);
}

test("blocks a table-only extension during the opening turn", async ({ page }) => {
  const controlled = await openControlledGame(page);
  await extendExistingRun(page);

  await expect(page.locator(".set.is-invalid")).toHaveCount(0);
  await expect(page.getByText("Opening set: 0 / 30", { exact: true })).toBeVisible();
  const reason = "Your opening turn can only use tiles from your rack; existing sets must stay unchanged.";
  await expect(page.locator(".table-surface")).toHaveAttribute("aria-label", expect.stringContaining(reason));
  await expect(page.getByRole("button", { name: "Commit turn" })).toBeDisabled();

  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".sr-only")).toHaveText(`Turn not ready. ${reason}`);
  expect(controlled.actionBodies).toEqual([]);
  expect(controlled.draftBodies).toHaveLength(1);
  expect(controlled.state().players.find((player) => player.id === targetPlayerId)?.opened).toBe(false);
  expect(controlled.state().board).toEqual([{ id: "set-existing", tileIds: existingRun }]);
});

test("blocks a 30-plus rack-only opening that also extends an existing table run", async ({ page }) => {
  const controlled = await openControlledGame(page);
  await placeRackSet(page, rackOpening);
  await extendExistingRun(page);

  await expect(page.locator(".set.is-invalid")).toHaveCount(0);
  await expect(page.getByText("Opening set: 33 / 30", { exact: true })).toBeVisible();
  const reason = "Your opening turn can only use tiles from your rack; existing sets must stay unchanged.";
  await expect(page.locator(".table-surface")).toHaveAttribute("aria-label", expect.stringContaining(reason));
  const commitButton = page.getByRole("button", { name: "Commit turn" });
  await expect(commitButton).toBeDisabled();
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".sr-only")).toHaveText(`Turn not ready. ${reason}`);

  expect(controlled.actionBodies).toEqual([]);
  expect(controlled.state().players.find((player) => player.id === targetPlayerId)?.opened).toBe(false);
  expect(controlled.state().myRack).toEqual([extenderId, ...rackOpening, ...rackFillers]);
});
