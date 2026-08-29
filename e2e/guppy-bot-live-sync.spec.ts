import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const requiredLiveBotUpdates = 5;

interface GameEvent {
  id: string;
  playerId: string | null;
  kind: "created" | "joined" | "started" | "played" | "drew" | "timeout" | "won";
  message: string;
}

interface LiveGameState {
  version: number;
  status: "lobby" | "playing" | "finished";
  currentPlayerId: string | null;
  myPlayerId: string;
  poolCount: number;
  board: Array<{ tileIds: string[] }>;
  myRack: string[];
  players: Array<{
    id: string;
    name: string;
    rackCount: number;
    isComputer: boolean;
  }>;
  history: GameEvent[];
}

interface SocketStateFrame {
  version: number;
  currentPlayerId: string | null;
  eventIds: string[];
}

function isBotAction(event: GameEvent, computerId: string): boolean {
  return event.playerId === computerId && (event.kind === "drew" || event.kind === "played");
}

async function getGameState(page: Page, roomCode: string): Promise<LiveGameState> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Game state failed with ${response.status}: ${await response.text()}`);
    return response.json() as Promise<LiveGameState>;
  }, `${appUrl}/api/games/${roomCode}`);
}

async function tryGetGameState(page: Page, roomCode: string): Promise<LiveGameState | null> {
  try {
    return await getGameState(page, roomCode);
  } catch {
    return null;
  }
}

test("streams repeated Guppy Bot turns into the human UI without a page refresh", async ({ page }) => {
  test.setTimeout(45_000);
  const socketStates: SocketStateFrame[] = [];

  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const message: unknown = JSON.parse(payload);
        if (
          typeof message !== "object"
          || message === null
          || !("type" in message)
          || message.type !== "state"
          || !("state" in message)
          || typeof message.state !== "object"
          || message.state === null
        ) return;
        const state = message.state as LiveGameState;
        socketStates.push({
          version: state.version,
          currentPlayerId: state.currentPlayerId,
          eventIds: state.history.map((event) => event.id),
        });
      } catch {
        // Non-JSON frames are not game-state updates.
      }
    });
  });

  await page.addInitScript(() => {
    const key = "guppycube:e2e-document-loads";
    const count = Number.parseInt(sessionStorage.getItem(key) ?? "0", 10);
    sessionStorage.setItem(key, String(count + 1));
  });

  await page.goto(appUrl);
  let liveBotUpdates = 0;
  let roomNumber = 0;
  let checkedUnauthorizedActionFailure = false;

  while (liveBotUpdates < requiredLiveBotUpdates) {
    roomNumber += 1;
    const playerName = `Sync ${roomNumber} ${Date.now().toString(36).slice(-6)}`;
    await page.getByLabel("Your name").fill(playerName);
    await page.locator(".player-count").getByRole("button", { name: "2", exact: true }).click();
    await page.getByRole("button", { name: "Create table" }).click();
    await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();

    const roomCode = await page.locator(".invite-code strong").innerText();
    await page.getByRole("button", { name: "Add computer" }).click();
    await expect(page.locator(".seat.is-computer").getByText("Guppy Bot", { exact: true })).toBeVisible();

    const lobbyState = await getGameState(page, roomCode);
    const computer = lobbyState.players.find((player) => player.isComputer);
    expect(computer).toBeDefined();
    const lobbyBotActions = lobbyState.history.filter((item) => isBotAction(item, computer!.id)).length;

    if (!checkedUnauthorizedActionFailure) {
      const anonymousApi = await playwrightRequest.newContext({ baseURL: appUrl });
      try {
        const unauthorizedActionResponse = await anonymousApi.post(`/api/games/${roomCode}/action`, {
          data: { action: { type: "draw" } },
        });
        expect(unauthorizedActionResponse.status()).toBe(401);
        await expect(unauthorizedActionResponse.json()).resolves.toEqual(expect.objectContaining({
          code: "invalid_session",
          error: "That player session is not valid.",
        }));
      } finally {
        await anonymousApi.dispose();
      }
      checkedUnauthorizedActionFailure = true;
    }

    await page.getByRole("button", { name: "Shuffle & start" }).click();
    await expect(page.getByLabel("Game table")).toBeVisible();
    await expect(page.locator(".connection-pill")).toContainText("online");
    await page.getByRole("button", { name: "Activity" }).click();
    const activity = page.locator(".activity-panel");
    const opponent = page.locator(".player-card").filter({ hasText: "Guppy Bot" });

    const verifyLiveUpdate = async (after: LiveGameState, latestBotAction: GameEvent) => {
      const updateNumber = liveBotUpdates + 1;
      const computerAfter = after.players.find((player) => player.id === computer!.id);
      expect(computerAfter).toBeDefined();

      if (after.status === "finished") {
        await expect(page.locator(".winner-banner"), {
          message: `the finished-game UI should stream Guppy Bot update ${updateNumber}`,
        }).toBeVisible({ timeout: 5_000 });
      } else {
        await expect(page.getByText("Your turn", { exact: true }), {
          message: `the visible turn indicator should advance after Guppy Bot update ${updateNumber}`,
        }).toBeVisible({ timeout: 5_000 });
      }
      if (!(await activity.isVisible())) {
        await page.getByRole("button", { name: "Activity" }).click();
      }
      await expect(activity, {
        message: `the activity panel should render Guppy Bot update ${updateNumber}`,
      }).toContainText(latestBotAction.message);
      await expect(opponent.locator(".mini-rack b"), {
        message: `the opponent rack count should match server state after Guppy Bot update ${updateNumber}`,
      }).toHaveText(String(computerAfter!.rackCount));
      await expect(page.locator(".sets .tile")).toHaveCount(
        after.board.flatMap((set) => set.tileIds).length,
      );
      await expect.poll(() => socketStates.some((state) =>
        state.version === after.version
        && state.currentPlayerId === after.currentPlayerId
        && state.eventIds.includes(latestBotAction.id)
      ), {
        message: `the browser should receive the version ${after.version} WebSocket state frame`,
        timeout: 5_000,
      }).toBe(true);
      liveBotUpdates += 1;
    };

    await expect.poll(async () => {
      const state = await tryGetGameState(page, roomCode);
      return Boolean(state && (state.status === "finished" || state.currentPlayerId === state.myPlayerId));
    }, {
      message: "the server should finish an opening computer turn when Guppy Bot was shuffled first",
      timeout: 10_000,
    }).toBe(true);

    let current = await getGameState(page, roomCode);
    const openingBotAction = current.history
      .filter((item) => isBotAction(item, computer!.id))
      .slice(lobbyBotActions)
      .at(-1);
    if (openingBotAction) await verifyLiveUpdate(current, openingBotAction);

    while (current.status === "playing" && liveBotUpdates < requiredLiveBotUpdates) {
      expect(current.currentPlayerId, "a human-triggered cycle should begin on the human turn").toBe(current.myPlayerId);
      const previousBotActions = current.history.filter((item) => isBotAction(item, computer!.id)).length;
      await page.getByRole("button", { name: "Draw & end" }).click();

      await expect.poll(async () => {
        const state = await tryGetGameState(page, roomCode);
        if (!state) return false;
        const botActions = state.history.filter((item) => isBotAction(item, computer!.id)).length;
        return botActions > previousBotActions
          && (state.status === "finished" || state.currentPlayerId === state.myPlayerId);
      }, {
        message: `the server should complete autonomous Guppy Bot update ${liveBotUpdates + 1}`,
        timeout: 10_000,
      }).toBe(true);

      current = await getGameState(page, roomCode);
      const latestBotAction = [...current.history].reverse().find((item) => isBotAction(item, computer!.id));
      expect(latestBotAction, `update ${liveBotUpdates + 1} should add a bot action`).toBeDefined();
      await verifyLiveUpdate(current, latestBotAction!);
    }

    if (current.status === "finished" && liveBotUpdates < requiredLiveBotUpdates) {
      await page.getByRole("button", { name: "Back home" }).click();
      await expect(page.getByRole("button", { name: "Create table" })).toBeVisible();
    }
  }

  expect(liveBotUpdates).toBe(requiredLiveBotUpdates);
  expect(await page.evaluate(() => sessionStorage.getItem("guppycube:e2e-document-loads"))).toBe("1");
});
