import { devices, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const ipadMiniProfiles = ["iPad Mini", "iPad Mini landscape"] as const;

async function openIpadMiniPage(browser: Browser, profileName: typeof ipadMiniProfiles[number]): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const { defaultBrowserType: _defaultBrowserType, ...profile } = devices[profileName];
  const context = await browser.newContext(profile);
  const page = await context.newPage();
  await page.goto(appUrl);
  await expect(page.getByRole("heading", { name: "Make a run for it." })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  return { context, page };
}

for (const profileName of ipadMiniProfiles) {
  test(`${profileName} shows the complete landing page without vertical scrolling`, async ({ browser }) => {
    const { context, page } = await openIpadMiniPage(browser, profileName);
    try {
      const layout = await page.evaluate(() => {
        const bounds = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) throw new Error(`Missing landing-page landmark: ${selector}`);
          const rect = element.getBoundingClientRect();
          return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
        };
        return {
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            visualHeight: window.visualViewport?.height ?? window.innerHeight,
          },
          documentHeight: document.documentElement.scrollHeight,
          bodyHeight: document.body.scrollHeight,
          touchPoints: navigator.maxTouchPoints,
          coarsePointer: window.matchMedia("(pointer: coarse)").matches,
          noHover: window.matchMedia("(hover: none)").matches,
          home: bounds(".home-shell"),
          nav: bounds(".home-nav"),
          heroCopy: bounds(".hero-copy"),
          entryCard: bounds(".entry-card"),
        };
      });

      expect(layout.touchPoints).toBeGreaterThan(0);
      expect(layout.coarsePointer).toBe(true);
      expect(layout.noHover).toBe(true);
      expect(layout.documentHeight).toBeLessThanOrEqual(Math.ceil(layout.viewport.height));
      expect(layout.bodyHeight).toBeLessThanOrEqual(Math.ceil(layout.viewport.height));

      for (const [name, bounds] of Object.entries({
        home: layout.home,
        nav: layout.nav,
        heroCopy: layout.heroCopy,
        entryCard: layout.entryCard,
      })) {
        expect(bounds.top, `${name} should start inside the visual viewport`).toBeGreaterThanOrEqual(-1);
        expect(bounds.left, `${name} should start inside the visual viewport`).toBeGreaterThanOrEqual(-1);
        expect(bounds.right, `${name} should end inside the visual viewport`).toBeLessThanOrEqual(layout.viewport.width + 1);
        expect(bounds.bottom, `${name} should end inside the visual viewport`).toBeLessThanOrEqual(layout.viewport.visualHeight + 1);
      }

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally {
      await context.close();
    }
  });
}

test("iPad Mini touch gestures produce the same landing-page states as mouse clicks", async ({ browser }) => {
  const { context, page } = await openIpadMiniPage(browser, "iPad Mini");
  try {
    const createTab = page.getByRole("tab", { name: "New table" });
    const joinTab = page.getByRole("tab", { name: "Join a table" });

    await joinTab.click();
    const mouseJoinState = {
      createSelected: await createTab.getAttribute("aria-selected"),
      joinSelected: await joinTab.getAttribute("aria-selected"),
      tableNameVisible: await page.getByLabel("Table name").isVisible(),
    };
    await createTab.click();
    await joinTab.tap();
    expect({
      createSelected: await createTab.getAttribute("aria-selected"),
      joinSelected: await joinTab.getAttribute("aria-selected"),
      tableNameVisible: await page.getByLabel("Table name").isVisible(),
    }).toEqual(mouseJoinState);

    await createTab.tap();
    const realtime = page.getByRole("radio", { name: /Realtime/ });
    const correspondence = page.getByRole("radio", { name: /Correspondence/ });
    await correspondence.click();
    const mouseModeState = {
      realtime: await realtime.isChecked(),
      correspondence: await correspondence.isChecked(),
    };
    await realtime.click();
    await correspondence.tap();
    expect({
      realtime: await realtime.isChecked(),
      correspondence: await correspondence.isChecked(),
    }).toEqual(mouseModeState);

    const twoSeats = page.locator(".player-count").getByRole("button", { name: "2", exact: true });
    const fourSeats = page.locator(".player-count").getByRole("button", { name: "4", exact: true });
    await twoSeats.click();
    const mouseSeatClass = await twoSeats.getAttribute("class");
    await fourSeats.click();
    await twoSeats.tap();
    expect(await twoSeats.getAttribute("class")).toBe(mouseSeatClass);

    const assistRules = page.locator(".assist-policy-picker");
    const assistSummary = assistRules.locator("summary");
    await assistSummary.click();
    const mouseAssistState = await assistRules.getAttribute("open");
    await assistSummary.click();
    await assistSummary.tap();
    expect(await assistRules.getAttribute("open")).toBe(mouseAssistState);

    const rulesButton = page.getByRole("button", { name: "How to play" });
    await rulesButton.click();
    const mouseDialogHeading = await page.getByRole("dialog").getByRole("heading", { name: "Make the table work." }).innerText();
    await page.getByRole("button", { name: "Close rules" }).click();
    await rulesButton.tap();
    const touchDialog = page.getByRole("dialog", { name: "Make the table work." });
    await expect(touchDialog).toBeVisible();
    expect(await touchDialog.getByRole("heading", { name: "Make the table work." }).innerText())
      .toBe(mouseDialogHeading);

    await touchDialog.getByRole("heading", { name: "Make the table work." }).tap();
    await expect(touchDialog, "a pointer-down inside the panel must not reach the backdrop").toBeVisible();

    await page.locator(".modal-backdrop").tap({ position: { x: 5, y: 5 } });
    await expect(touchDialog, "a touch pointer-down on the backdrop should dismiss the rules").toBeHidden();
  } finally {
    await context.close();
  }
});

test("iPad Mini can tap a rack tile onto the table and pick up the whole meld", async ({ browser, request }) => {
  test.setTimeout(30_000);
  const { context, page } = await openIpadMiniPage(browser, "iPad Mini");
  try {
    const stamp = Date.now().toString(36).slice(-8);
    await page.getByLabel("Your name").fill(`Touch host ${stamp}`);
    await page.locator(".player-count").getByRole("button", { name: "2", exact: true }).tap();
    await page.getByRole("button", { name: "Create table" }).tap();
    await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();

    const roomCode = await page.locator(".invite-code strong").innerText();
    const joinResponse = await request.post(`${appUrl}/api/games/${roomCode}/join`, {
      data: { name: `Touch guest ${stamp}` },
    });
    expect(joinResponse.status()).toBe(201);
    const guestStateResponse = await request.get(`${appUrl}/api/games/${roomCode}`);
    expect(guestStateResponse.ok()).toBe(true);
    const guestState = await guestStateResponse.json() as { myPlayerId: string };
    await expect(page.getByText("2 of 2", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Shuffle & start" }).tap();
    await expect(page.getByLabel("Game table")).toBeVisible();
    const hostState = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`Game state failed with ${response.status}: ${await response.text()}`);
      return response.json() as Promise<{ currentPlayerId: string | null; myPlayerId: string }>;
    }, `${appUrl}/api/games/${roomCode}`);
    if (hostState.currentPlayerId !== hostState.myPlayerId) {
      expect(hostState.currentPlayerId).toBe(guestState.myPlayerId);
      const guestDraw = await request.post(`${appUrl}/api/games/${roomCode}/action`, {
        data: { action: { type: "draw" } },
      });
      expect(guestDraw.ok()).toBe(true);
    }
    await expect(page.getByText("Your turn", { exact: true })).toBeVisible();

    const firstRackTile = page.locator(".rack .tile").first();
    await firstRackTile.tap();
    await expect(firstRackTile).toHaveAttribute("aria-pressed", "true");

    const newMeld = page.getByRole("button", { name: /New meld/ });
    const selectionActionHeight = await newMeld.evaluate((button) => button.getBoundingClientRect().height);
    expect(selectionActionHeight).toBeGreaterThanOrEqual(40);
    await newMeld.tap();
    await expect(page.locator(".meld")).toHaveCount(1);
    await expect(page.locator(".meld .tile")).toHaveCount(1);

    const meldHandle = page.locator(".meld").first().locator(":scope > .meld-drag-handle");
    await expect(meldHandle).toBeVisible();
    await expect(meldHandle).toHaveAccessibleName("Pick up meld 1");
    await expect(meldHandle).toHaveCSS("opacity", "1");
    await expect(meldHandle).toHaveCSS("pointer-events", "auto");
    const handleSize = await meldHandle.evaluate((handle) => {
      const bounds = handle.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    });
    expect(handleSize.width).toBeGreaterThanOrEqual(32);
    expect(handleSize.height).toBeGreaterThanOrEqual(44);

    await meldHandle.tap();
    await expect(meldHandle).toHaveAttribute("aria-pressed", "true");
    await expect(meldHandle).toHaveAccessibleName("Put down meld 1");
    await expect(page.getByRole("button", { name: /Cancel meld move/ })).toBeVisible();
    await meldHandle.tap();
    await expect(meldHandle).toHaveAttribute("aria-pressed", "false");
  } finally {
    await context.close();
  }
});
