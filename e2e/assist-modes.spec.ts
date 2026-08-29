import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");

type AssistId = "no-move-alert" | "auto-draw" | "rack-set-highlights";
type AssistPolicy = "default-on" | "default-off" | "disallowed";
type AssistPolicyMap = Record<AssistId, AssistPolicy>;

interface AssistGameState {
  version: number;
  status: "lobby" | "playing" | "finished";
  currentPlayerId: string | null;
  myPlayerId: string;
  poolCount: number;
  board: Array<{ id: string; tileIds: string[] }>;
  players: Array<{ id: string; opened: boolean }>;
  myRack: string[];
  tiles: Record<string, {
    id: string;
    color: "coral" | "sun" | "ocean" | "ink" | null;
    value: number | null;
    wilcard: boolean;
  }>;
  assistPolicy: AssistPolicyMap;
  enabledAssists: AssistId[];
  noMovePossible: boolean;
  history: Array<{
    kind: string;
    message: string;
  }>;
}

interface TwoPlayerGame {
  roomCode: string;
  hostContext: BrowserContext;
  guestContext: BrowserContext;
}

interface OpeningMoveProof {
  hasMove: boolean;
  sets: string[][];
  points: number;
}

interface ClassifiedGame {
  game: TwoPlayerGame;
  currentContext: BrowserContext;
  otherContext: BrowserContext;
  state: AssistGameState;
  proof: OpeningMoveProof;
}

function describeRack(state: AssistGameState): string {
  return state.myRack.map((id) => {
    const tile = state.tiles[id];
    return tile?.wilcard ? `${id}(wilcard)` : `${id}(${tile?.color}-${tile?.value})`;
  }).join(", ");
}

/**
 * An intentionally independent opening-move oracle for live tests. It does not
 * call the app's hasLegalMove implementation: every rack subset is classified
 * as a group/run, then disjoint sets are searched for the 30-point opening.
 */
function openingMoveProof(state: AssistGameState): OpeningMoveProof {
  const rack = state.myRack;
  const candidates: Array<{ mask: number; tileIds: string[]; points: number }> = [];

  const setPoints = (tileIds: string[]): number | null => {
    const selected = tileIds.map((id) => state.tiles[id]);
    const numbered = selected.filter((tile) => tile && !tile.wilcard);
    if (numbered.length === 0) return null;

    let groupPoints: number | null = null;
    if (selected.length === 3 || selected.length === 4) {
      const value = numbered[0]?.value;
      const colors = numbered.map((tile) => tile!.color);
      if (
        value !== null
        && value !== undefined
        && numbered.every((tile) => tile!.value === value)
        && colors.every((color) => color !== null)
        && new Set(colors).size === colors.length
      ) {
        groupPoints = value * selected.length;
      }
    }

    let runPoints: number | null = null;
    if (selected.length >= 3 && selected.length <= 13) {
      const colors = new Set(numbered.map((tile) => tile!.color));
      const values = numbered.map((tile) => tile!.value);
      if (
        colors.size === 1
        && !colors.has(null)
        && values.every((value): value is number => value !== null)
        && new Set(values).size === values.length
      ) {
        for (let start = 1; start <= 14 - selected.length; start += 1) {
          const end = start + selected.length - 1;
          if (values.every((value) => value >= start && value <= end)) {
            runPoints = Math.max(
              runPoints ?? 0,
              (selected.length * (start + end)) / 2,
            );
          }
        }
      }
    }

    if (groupPoints === null) return runPoints;
    if (runPoints === null) return groupPoints;
    return Math.max(groupPoints, runPoints);
  };

  for (let mask = 1; mask < 1 << rack.length; mask += 1) {
    let size = 0;
    const tileIds: string[] = [];
    for (let index = 0; index < rack.length; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      size += 1;
      tileIds.push(rack[index]!);
    }
    if (size < 3) continue;
    const points = setPoints(tileIds);
    if (points !== null) candidates.push({ mask, tileIds, points });
  }

  const search = (start: number, usedMask: number, points: number, sets: string[][]): OpeningMoveProof | null => {
    if (points >= 30) return { hasMove: true, sets, points };
    for (let index = start; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      if ((candidate.mask & usedMask) !== 0) continue;
      const result = search(
        index + 1,
        usedMask | candidate.mask,
        points + candidate.points,
        [...sets, candidate.tileIds],
      );
      if (result) return result;
    }
    return null;
  };

  return search(0, 0, 0, []) ?? { hasMove: false, sets: [], points: 0 };
}

async function getGame(context: BrowserContext, roomCode: string): Promise<AssistGameState> {
  const response = await context.request.get(`${appUrl}/api/games/${roomCode}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<AssistGameState>;
}

async function createTwoPlayerGame(
  browser: Browser,
  assistPolicy: AssistPolicyMap,
  suffix: string,
): Promise<TwoPlayerGame> {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const createResponse = await hostContext.request.post(`${appUrl}/api/games`, {
      data: {
        name: `Host ${suffix}`,
        mode: "realtime",
        maxPlayers: 2,
        assistPolicy,
      },
    });
    expect(createResponse.status()).toBe(201);
    const { roomCode } = await createResponse.json() as { roomCode: string };

    const joinResponse = await guestContext.request.post(`${appUrl}/api/games/${roomCode}/join`, {
      data: { name: `Guest ${suffix}` },
    });
    expect(joinResponse.status()).toBe(201);
    return { roomCode, hostContext, guestContext };
  } catch (error) {
    await Promise.all([hostContext.close(), guestContext.close()]);
    throw error;
  }
}

async function expectLobby(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();
}

test("creates a table with tri-state assist rules and enforces disallowed assists", async ({ page }) => {
  const playerName = `Policy ${Date.now().toString(36).slice(-7)}`;

  await page.goto(appUrl);
  await page.getByLabel("Your name").fill(playerName);
  await page.getByText("Assist rules", { exact: true }).click();

  const noMoveOff = page.getByRole("radio", { name: "No-move alert: Off" });
  const noMoveAllowed = page.getByRole("radio", { name: "No-move alert: Allowed" });
  const autoDrawOff = page.getByRole("radio", { name: "Auto-draw: Off" });
  const rackSetHighlightsOff = page.getByRole("radio", { name: "Rack set highlights: Off" });
  const rackSetHighlightsAllowed = page.getByRole("radio", { name: "Rack set highlights: Allowed" });
  await expect(noMoveOff).toBeChecked();
  await expect(autoDrawOff).toBeChecked();
  await expect(rackSetHighlightsOff).toBeChecked();

  await noMoveAllowed.check();
  await rackSetHighlightsAllowed.check();
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/api/games")
  );
  await page.getByRole("button", { name: "Create table" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  expect(createResponse.request().postDataJSON()).toEqual({
    name: playerName,
    mode: "realtime",
    maxPlayers: 4,
    assistPolicy: {
      "no-move-alert": "default-off",
      "auto-draw": "disallowed",
      "rack-set-highlights": "default-off",
    },
  });

  await expectLobby(page);
  const roomCode = await page.locator(".invite-code strong").innerText();
  const controls = page.locator('section[aria-label="Your assists"]');
  await expect(controls.getByRole("switch", { name: "No-move alert" })).not.toBeChecked();
  await expect(controls.getByRole("switch", { name: "Rack set highlights" })).not.toBeChecked();
  await expect(controls.getByRole("switch", { name: "Auto-draw" })).toHaveCount(0);
  await expect(controls.getByText("Not allowed", { exact: true })).toBeVisible();

  const state = await getGame(page.context(), roomCode);
  expect(state.assistPolicy).toEqual({
    "no-move-alert": "default-off",
    "auto-draw": "disallowed",
    "rack-set-highlights": "default-off",
  });
  expect(state.enabledAssists).toEqual([]);

  const disallowedResponse = await page.context().request.post(`${appUrl}/api/games/${roomCode}/assists`, {
    data: { assistId: "auto-draw", enabled: true },
  });
  expect(disallowedResponse.status()).toBe(409);
  await expect(disallowedResponse.json()).resolves.toEqual({
    error: "That assist is not allowed at this table.",
    code: "assist_not_allowed",
  });

  const unknownAssistResponse = await page.context().request.post(`${appUrl}/api/games/${roomCode}/assists`, {
    data: { assistId: "future-assist", enabled: true },
  });
  expect(unknownAssistResponse.status()).toBe(400);
  await expect(unknownAssistResponse.json()).resolves.toEqual(expect.objectContaining({
    code: "invalid_assist",
    error: expect.stringContaining("assistId"),
  }));
});

test("keeps each player's assist toggles independent in the lobby and active game", async ({ browser }) => {
  const game = await createTwoPlayerGame(browser, {
    "no-move-alert": "default-off",
    "auto-draw": "default-off",
    "rack-set-highlights": "default-off",
  }, Date.now().toString(36).slice(-7));

  try {
    const hostPage = await game.hostContext.newPage();
    const guestPage = await game.guestContext.newPage();
    await Promise.all([
      hostPage.goto(`${appUrl}/room/${game.roomCode}`),
      guestPage.goto(`${appUrl}/room/${game.roomCode}`),
    ]);
    await Promise.all([expectLobby(hostPage), expectLobby(guestPage)]);

    const hostLobbyAssists = hostPage.locator('section[aria-label="Your assists"]');
    const guestLobbyAssists = guestPage.locator('section[aria-label="Your assists"]');
    await expect(hostLobbyAssists.getByRole("switch", { name: "No-move alert" })).not.toBeChecked();
    await expect(guestLobbyAssists.getByRole("switch", { name: "No-move alert" })).not.toBeChecked();

    await hostLobbyAssists.getByRole("switch", { name: "No-move alert" }).click();
    await expect.poll(async () => (await getGame(game.hostContext, game.roomCode)).enabledAssists)
      .toEqual(["no-move-alert"]);
    expect((await getGame(game.guestContext, game.roomCode)).enabledAssists).toEqual([]);

    await guestLobbyAssists.getByRole("switch", { name: "Auto-draw" }).click();
    await expect.poll(async () => (await getGame(game.guestContext, game.roomCode)).enabledAssists)
      .toEqual(["auto-draw"]);
    expect((await getGame(game.hostContext, game.roomCode)).enabledAssists).toEqual(["no-move-alert"]);

    await hostPage.getByRole("button", { name: "Shuffle & start" }).click();
    await Promise.all([
      expect(hostPage.getByLabel("Game table")).toBeVisible(),
      expect(guestPage.getByLabel("Game table")).toBeVisible(),
    ]);

    await Promise.all([
      hostPage.getByRole("button", { name: "Assists" }).click(),
      guestPage.getByRole("button", { name: "Assists" }).click(),
    ]);
    const hostPanel = hostPage.locator(".assist-panel");
    const guestPanel = guestPage.locator(".assist-panel");
    await expect(hostPanel.getByRole("switch", { name: "No-move alert" })).toBeChecked();
    await expect(hostPanel.getByRole("switch", { name: "Auto-draw" })).not.toBeChecked();
    await expect(guestPanel.getByRole("switch", { name: "No-move alert" })).not.toBeChecked();
    await expect(guestPanel.getByRole("switch", { name: "Auto-draw" })).toBeChecked();

    await hostPanel.getByRole("switch", { name: "No-move alert" }).click();
    await guestPanel.getByRole("switch", { name: "No-move alert" }).click();
    await expect.poll(async () => (await getGame(game.hostContext, game.roomCode)).enabledAssists)
      .toEqual([]);
    await expect.poll(async () => (await getGame(game.guestContext, game.roomCode)).enabledAssists)
      .toEqual(["no-move-alert", "auto-draw"]);
  } finally {
    await Promise.all([game.hostContext.close(), game.guestContext.close()]);
  }
});

test("matches live opening game states and only auto-draws the truly blocked turn", async ({ browser }) => {
  test.setTimeout(120_000);
  let blocked: ClassifiedGame | undefined;
  let playable: ClassifiedGame | undefined;

  try {
    for (let attempt = 1; attempt <= 60 && (!blocked || !playable); attempt += 1) {
      const game = await createTwoPlayerGame(browser, {
        "no-move-alert": "default-on",
        "auto-draw": "default-off",
        "rack-set-highlights": "default-off",
      }, `S${attempt}-${Date.now().toString(36).slice(-5)}`);
      const startResponse = await game.hostContext.request.post(`${appUrl}/api/games/${game.roomCode}/start`, {
        data: {},
      });
      expect(startResponse.ok()).toBe(true);

      const [hostState, guestState] = await Promise.all([
        getGame(game.hostContext, game.roomCode),
        getGame(game.guestContext, game.roomCode),
      ]);
      const hostIsCurrent = hostState.currentPlayerId === hostState.myPlayerId;
      const state = hostIsCurrent ? hostState : guestState;
      const otherState = hostIsCurrent ? guestState : hostState;
      const proof = openingMoveProof(state);
      const snapshot = `room ${game.roomCode}; rack: ${describeRack(state)}; proof: ${JSON.stringify(proof)}`;

      expect(state.status, snapshot).toBe("playing");
      expect(state.board, snapshot).toEqual([]);
      expect(state.players.find((player) => player.id === state.myPlayerId)?.opened, snapshot).toBe(false);
      expect(state.enabledAssists, snapshot).toEqual(["no-move-alert"]);
      expect(state.noMovePossible, snapshot).toBe(!proof.hasMove);
      expect(otherState.noMovePossible, `non-current player in ${snapshot}`).toBe(false);

      const classified: ClassifiedGame = {
        game,
        currentContext: hostIsCurrent ? game.hostContext : game.guestContext,
        otherContext: hostIsCurrent ? game.guestContext : game.hostContext,
        state,
        proof,
      };
      if (proof.hasMove && !playable) playable = classified;
      else if (!proof.hasMove && !blocked) blocked = classified;
      else await Promise.all([game.hostContext.close(), game.guestContext.close()]);
    }

    expect(blocked, "60 fresh deals should include an independently proven blocked opening rack").toBeDefined();
    expect(playable, "60 fresh deals should include an independently proven legal 30-point opening").toBeDefined();

    const playableSnapshot = `room ${playable!.game.roomCode}; rack: ${describeRack(playable!.state)}; proof: ${JSON.stringify(playable!.proof)}`;
    expect(playable!.proof.points, playableSnapshot).toBeGreaterThanOrEqual(30);
    const playableAssistResponse = await playable!.currentContext.request.post(
      `${appUrl}/api/games/${playable!.game.roomCode}/assists`,
      { data: { assistId: "auto-draw", enabled: true } },
    );
    expect(playableAssistResponse.status()).toBe(200);

    // setAssist schedules the actual room alarm. Give the 250ms auto-draw
    // window ample time to fire; a genuinely playable rack must stay put.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const playableAfterAlarmWindow = await getGame(playable!.currentContext, playable!.game.roomCode);
    expect(playableAfterAlarmWindow.currentPlayerId, playableSnapshot).toBe(playable!.state.myPlayerId);
    expect(playableAfterAlarmWindow.poolCount, playableSnapshot).toBe(playable!.state.poolCount);
    expect(playableAfterAlarmWindow.myRack, playableSnapshot).toEqual(playable!.state.myRack);
    expect(playableAfterAlarmWindow.version, playableSnapshot).toBe(playable!.state.version + 1);
    expect(playableAfterAlarmWindow.enabledAssists, playableSnapshot).toEqual(["no-move-alert", "auto-draw"]);
    expect(playableAfterAlarmWindow.noMovePossible, playableSnapshot).toBe(false);
    expect(playableAfterAlarmWindow.history, playableSnapshot).not.toContainEqual(expect.objectContaining({
      message: expect.stringContaining("auto-drew"),
    }));

    const blockedSnapshot = `room ${blocked!.game.roomCode}; rack: ${describeRack(blocked!.state)}`;
    // Auto-draw starts disabled: a blocked state remains unchanged until the
    // player opts in, proving this is not the normal deadline path.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const blockedBeforeOptIn = await getGame(blocked!.currentContext, blocked!.game.roomCode);
    expect(blockedBeforeOptIn.currentPlayerId, blockedSnapshot).toBe(blocked!.state.myPlayerId);
    expect(blockedBeforeOptIn.version, blockedSnapshot).toBe(blocked!.state.version);
    expect(blockedBeforeOptIn.poolCount, blockedSnapshot).toBe(blocked!.state.poolCount);

    // The public flag is intentionally assist-gated. Toggle it off and back on
    // without changing the underlying turn to exercise both view branches.
    for (const enabled of [false, true]) {
      const response = await blocked!.currentContext.request.post(
        `${appUrl}/api/games/${blocked!.game.roomCode}/assists`,
        { data: { assistId: "no-move-alert", enabled } },
      );
      expect(response.status()).toBe(200);
      const toggledState = await getGame(blocked!.currentContext, blocked!.game.roomCode);
      expect(toggledState.currentPlayerId, blockedSnapshot).toBe(blocked!.state.myPlayerId);
      expect(toggledState.noMovePossible, blockedSnapshot).toBe(enabled);
    }

    const page = await blocked!.currentContext.newPage();
    await page.goto(`${appUrl}/room/${blocked!.game.roomCode}`);
    await page.getByRole("button", { name: "Assists" }).click();
    const autoDraw = page.locator(".assist-panel").getByRole("switch", { name: "Auto-draw" });
    await expect(autoDraw).not.toBeChecked();
    const setAssistResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith(`/api/games/${blocked!.game.roomCode}/assists`)
      && response.request().postDataJSON()?.assistId === "auto-draw"
    );
    await autoDraw.click();
    expect((await setAssistResponsePromise).status()).toBe(200);

    await expect.poll(async () => {
      const state = await getGame(blocked!.currentContext, blocked!.game.roomCode);
      return state.history.find((item) => item.message.includes("auto-drew a tile because no move was possible"))
        ?.message;
    }, {
      message: `the server room alarm should auto-draw for ${blockedSnapshot}`,
      timeout: 10_000,
    }).toContain("auto-drew a tile because no move was possible");

    const blockedAfterAutoDraw = await getGame(blocked!.currentContext, blocked!.game.roomCode);
    expect(blockedAfterAutoDraw.currentPlayerId, blockedSnapshot).not.toBe(blocked!.state.myPlayerId);
    expect(blockedAfterAutoDraw.poolCount, blockedSnapshot).toBe(blocked!.state.poolCount - 1);
    expect(blockedAfterAutoDraw.myRack, blockedSnapshot).toHaveLength(blocked!.state.myRack.length + 1);
    expect(blockedAfterAutoDraw.enabledAssists, blockedSnapshot).toEqual(["no-move-alert", "auto-draw"]);
    expect(blockedAfterAutoDraw.noMovePossible, blockedSnapshot).toBe(false);
    const otherPlayerAfterAutoDraw = await getGame(blocked!.otherContext, blocked!.game.roomCode);
    expect(otherPlayerAfterAutoDraw.currentPlayerId, blockedSnapshot).toBe(otherPlayerAfterAutoDraw.myPlayerId);
  } finally {
    const games = new Set([blocked?.game, playable?.game].filter((game): game is TwoPlayerGame => Boolean(game)));
    await Promise.all([...games].flatMap((game) => [game.hostContext.close(), game.guestContext.close()]));
  }
});
