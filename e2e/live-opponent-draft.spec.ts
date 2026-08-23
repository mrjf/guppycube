import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { PublicGameState } from "../src/schemas";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");

interface HumanSeat {
  context: BrowserContext;
  name: string;
  page: Page;
  state: PublicGameState;
}

async function getGame(context: BrowserContext, roomCode: string): Promise<PublicGameState> {
  const response = await context.request.get(`${appUrl}/api/games/${roomCode}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<PublicGameState>;
}

async function openTwoHumanSeats(browser: Browser): Promise<{
  active: HumanSeat;
  roomCode: string;
  viewer: HumanSeat;
}> {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const suffix = Date.now().toString(36).slice(-7);
  const hostName = `Live host ${suffix}`;
  const guestName = `Live guest ${suffix}`;

  try {
    const createResponse = await hostContext.request.post(`${appUrl}/api/games`, {
      data: {
        name: hostName,
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
      data: { name: guestName },
    });
    expect(joinResponse.status()).toBe(201);
    expect((await hostContext.request.post(`${appUrl}/api/games/${roomCode}/start`, { data: {} })).ok()).toBe(true);

    const [hostState, guestState] = await Promise.all([
      getGame(hostContext, roomCode),
      getGame(guestContext, roomCode),
    ]);
    expect(hostState.players).toHaveLength(2);
    expect(hostState.players.every((player) => !player.isComputer)).toBe(true);

    const [hostPage, guestPage] = await Promise.all([
      hostContext.newPage(),
      guestContext.newPage(),
    ]);
    const host: HumanSeat = { context: hostContext, name: hostName, page: hostPage, state: hostState };
    const guest: HumanSeat = { context: guestContext, name: guestName, page: guestPage, state: guestState };
    const active = hostState.myPlayerId === hostState.currentPlayerId ? host : guest;
    const viewer = active === host ? guest : host;

    await Promise.all([
      active.page.goto(`${appUrl}/room/${roomCode}`),
      viewer.page.goto(`${appUrl}/room/${roomCode}`),
    ]);
    await Promise.all([
      expect(active.page.locator(".connection-pill")).toContainText("online"),
      expect(viewer.page.locator(".connection-pill")).toContainText("online"),
    ]);
    await expect(active.page.getByText("Your turn", { exact: true })).toBeVisible();
    await expect(viewer.page.locator(".turn-clock small")).toHaveText(`${active.name}'s turn`);

    return { active, roomCode, viewer };
  } catch (error) {
    await Promise.all([hostContext.close(), guestContext.close()]);
    throw error;
  }
}

test("shows a human opponent's live table attempt without exposing their private rack", async ({ browser }) => {
  const { active, roomCode, viewer } = await openTwoHumanSeats(browser);

  try {
    const activeRack = [...active.state.myRack];
    const draftedTileId = activeRack[0]!;
    const activePlayerAsSeenByViewer = viewer.state.players.find(
      (player) => player.id === active.state.myPlayerId,
    );
    expect(activePlayerAsSeenByViewer).toEqual(expect.objectContaining({
      isComputer: false,
      rackCount: activeRack.length,
      rackTileIds: [],
    }));

    const firstDraftResponse = active.page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith(`/api/games/${roomCode}/draft`),
    );
    await active.page.locator(`.rack .tile[data-tile-id="${draftedTileId}"]`).dblclick();
    expect((await firstDraftResponse).ok()).toBe(true);

    const viewerTable = viewer.page.getByLabel(/Game table/);
    await expect(viewer.page.locator(`.table-surface .tile[data-tile-id="${draftedTileId}"]`)).toBeVisible();
    await expect(viewerTable).toHaveClass(/\bis-watching-live\b/);
    await expect(viewerTable).toHaveClass(/\bhas-board-defect\b/);
    await expect(viewerTable).toHaveAccessibleName(/live attempt by .*Needs attention:/i);
    await expect(viewer.page.locator(".table-drop-instruction")).toHaveCount(0);
    await expect(viewer.page.locator(".meld.is-invalid")).toHaveCount(1);
    await expect(viewer.page.locator(".meld-status")).toHaveCount(0);

    const draftAsSeenByActive = await getGame(active.context, roomCode);
    const draftAsSeenByViewer = await getGame(viewer.context, roomCode);
    expect(draftAsSeenByActive.currentPlayerId).toBe(active.state.myPlayerId);
    expect(draftAsSeenByActive.board).toEqual([]);
    expect(draftAsSeenByActive.myTurnDraft).toEqual([
      expect.objectContaining({ tileIds: [draftedTileId] }),
    ]);
    expect(draftAsSeenByViewer.board).toEqual([]);
    expect(draftAsSeenByViewer.turnDraft).toEqual([
      expect.objectContaining({ tileIds: [draftedTileId] }),
    ]);
    expect(draftAsSeenByViewer.myTurnDraft).toBeNull();

    await active.page.reload();
    await expect(active.page.getByText("Your turn", { exact: true })).toBeVisible();
    await expect(active.page.getByRole("button", { name: "Reset turn" })).toBeEnabled();

    const activeCard = viewer.page.locator(".player-card").filter({
      has: viewer.page.getByText(active.name, { exact: true }),
    });
    await expect(activeCard.locator(".mini-rack b")).toHaveText(String(activeRack.length));
    await expect(activeCard.locator(".tile")).toHaveCount(0);
    await expect(viewer.page.getByRole("button", { name: new RegExp(`Show ${active.name}'s rack`) })).toHaveCount(0);
    for (const privateTileId of activeRack.slice(1)) {
      await expect(viewer.page.locator(`[data-tile-id="${privateTileId}"]`)).toHaveCount(0);
    }

    const resetResponse = active.page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith(`/api/games/${roomCode}/draft`),
    );
    await active.page.getByRole("button", { name: "Reset turn" }).click();
    expect((await resetResponse).ok()).toBe(true);
    await expect(viewer.page.locator(".table-surface .tile")).toHaveCount(0);
    await expect(viewerTable).not.toHaveClass(/\bis-watching-live\b/);
    await expect(viewerTable).not.toHaveClass(/\bhas-board-defect\b/);
    await expect(viewer.page.locator(".table-drop-instruction")).toHaveCount(0);
    await expect.poll(async () => (await getGame(viewer.context, roomCode)).turnDraft).toEqual([]);

    const secondDraftResponse = active.page.waitForResponse((response) =>
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith(`/api/games/${roomCode}/draft`),
    );
    await active.page.locator(`.rack .tile[data-tile-id="${draftedTileId}"]`).dblclick();
    expect((await secondDraftResponse).ok()).toBe(true);
    await expect(viewer.page.locator(`.table-surface .tile[data-tile-id="${draftedTileId}"]`)).toBeVisible();

    active.page.once("dialog", (dialog) => void dialog.accept());
    const drawResponse = active.page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith(`/api/games/${roomCode}/action`),
    );
    await active.page.locator(".pool-count").click();
    expect((await drawResponse).ok()).toBe(true);

    await expect(viewer.page.getByText("Your turn", { exact: true })).toBeVisible();
    await expect(viewer.page.locator(".table-surface .tile")).toHaveCount(0);
    await expect(active.page.locator(".table-surface .tile")).toHaveCount(0);
    await expect(viewerTable).not.toHaveClass(/\bis-watching-live\b/);
    await expect(viewerTable).not.toHaveClass(/\bhas-board-defect\b/);
    await expect(active.page.locator(".rack .tile")).toHaveCount(activeRack.length + 1);

    const endedAsSeenByActive = await getGame(active.context, roomCode);
    const endedAsSeenByViewer = await getGame(viewer.context, roomCode);
    expect(endedAsSeenByViewer.currentPlayerId).toBe(viewer.state.myPlayerId);
    expect(endedAsSeenByViewer.board).toEqual([]);
    expect(endedAsSeenByViewer.turnDraft).toBeNull();
    expect(endedAsSeenByActive.myRack).toHaveLength(activeRack.length + 1);
    expect(endedAsSeenByActive.myRack).toEqual(expect.arrayContaining(activeRack));
  } finally {
    await Promise.all([active.context.close(), viewer.context.close()]);
  }
});
