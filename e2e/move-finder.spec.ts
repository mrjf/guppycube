import { expect, test } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");

test("shows the rack + felt move finder and leaves the draft under player control", async ({ page, request }) => {
  const createResponse = await page.context().request.post(`${appUrl}/api/games`, {
    data: {
      name: `Finder host ${Date.now().toString(36).slice(-6)}`,
      mode: "realtime",
      maxPlayers: 2,
      assistPolicy: {
        "no-move-alert": "default-off",
        "auto-draw": "default-off",
        "rack-set-highlights": "default-off",
      },
    },
  });
  expect(createResponse.status()).toBe(201);
  const { roomCode } = await createResponse.json() as { roomCode: string };

  const joinResponse = await request.post(`${appUrl}/api/games/${roomCode}/join`, {
    data: { name: `Finder guest ${Date.now().toString(36).slice(-6)}` },
  });
  expect(joinResponse.status()).toBe(201);

  const startResponse = await page.context().request.post(`${appUrl}/api/games/${roomCode}/start`, { data: {} });
  expect(startResponse.ok()).toBe(true);

  await page.goto(`${appUrl}/room/${roomCode}`);
  await expect(page.getByLabel("Game table")).toBeVisible();
  await page.getByRole("button", { name: "Move finder" }).click();

  const panel = page.locator(".move-finder-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("status")).toBeVisible();
  await expect(panel).toContainText(/No move is possible|playable line/);

  const stageButtons = panel.getByRole("button", { name: "Stage" });
  if (await stageButtons.count() > 0) {
    await stageButtons.first().click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: "Commit turn" })).toBeVisible();
  }
});
