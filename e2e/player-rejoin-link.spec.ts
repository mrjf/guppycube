import { expect, test, type BrowserContext } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");

test("host can copy a guest rejoin link for a fresh browser", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  let rejoinedContext: BrowserContext | null = null;
  const suffix = Date.now().toString(36).slice(-6);
  const hostName = `Host rejoin ${suffix}`;
  const guestName = `Guest rejoin ${suffix}`;

  try {
    await hostContext.addInitScript(() => {
      const testWindow = window as typeof window & { copiedRejoinLink?: string };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (link: string) => {
            testWindow.copiedRejoinLink = link;
          },
        },
      });
    });

    const createResponse = await hostContext.request.post(`${appUrl}/api/games`, {
      data: { name: hostName, mode: "realtime", maxPlayers: 2 },
    });
    expect(createResponse.status()).toBe(201);
    const { roomCode } = await createResponse.json() as { roomCode: string };

    const joinResponse = await guestContext.request.post(`${appUrl}/api/games/${roomCode}/join`, {
      data: { name: guestName },
    });
    expect(joinResponse.status()).toBe(201);

    const [hostPage, guestPage] = await Promise.all([
      hostContext.newPage(),
      guestContext.newPage(),
    ]);
    await Promise.all([
      hostPage.goto(`${appUrl}/room/${roomCode}`),
      guestPage.goto(`${appUrl}/room/${roomCode}`),
    ]);
    await Promise.all([
      expect(hostPage.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible(),
      expect(guestPage.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible(),
    ]);

    const guestRejoinButton = hostPage.getByRole("button", {
      name: `Copy rejoin link for ${guestName}`,
      exact: true,
    });
    await expect(guestRejoinButton).toBeVisible();
    await expect(hostPage.getByRole("button", {
      name: `Copy rejoin link for ${hostName}`,
      exact: true,
    })).toHaveCount(0);
    await expect(guestPage.getByRole("button", { name: /^Copy rejoin link for / })).toHaveCount(0);

    await guestRejoinButton.click();
    await expect(hostPage.getByRole("button", {
      name: `Rejoin link copied for ${guestName}`,
      exact: true,
    })).toBeVisible();
    await expect.poll(() => hostPage.evaluate(() =>
      (window as typeof window & { copiedRejoinLink?: string }).copiedRejoinLink,
    )).toBeTruthy();
    const rejoinLink = await hostPage.evaluate(() =>
      (window as typeof window & { copiedRejoinLink?: string }).copiedRejoinLink!,
    );
    expect(new URL(rejoinLink).pathname).toMatch(new RegExp(`/room/${roomCode}/?$`));
    expect(new URL(rejoinLink).searchParams.get("player")).toBeTruthy();

    const startResponse = await hostContext.request.post(`${appUrl}/api/games/${roomCode}/start`, {
      data: {},
    });
    expect(startResponse.ok()).toBe(true);
    await expect(hostPage.getByLabel("Game table")).toBeVisible();

    rejoinedContext = await browser.newContext();
    const rejoinedPage = await rejoinedContext.newPage();
    await rejoinedPage.goto(rejoinLink);
    await expect(rejoinedPage.getByLabel("Game table")).toBeVisible();
    const restoredGuestCard = rejoinedPage.locator(".player-card.is-me").filter({ hasText: guestName });
    await expect(restoredGuestCard).toHaveCount(1);
    await expect(restoredGuestCard.locator(".you-badge")).toHaveText("You");
    await expect(rejoinedPage.getByRole("button", { name: /^Copy rejoin link for / })).toHaveCount(0);
  } finally {
    await Promise.all([
      hostContext.close(),
      guestContext.close(),
      ...(rejoinedContext ? [rejoinedContext.close()] : []),
    ]);
  }
});
