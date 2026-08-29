import { expect, test } from "@playwright/test";

const appUrl = (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
const hubUrl = (process.env.DEV_HUB_URL ?? "http://127.0.0.1:43900").replace(/\/+$/, "");
const appBasePath = new URL(appUrl).pathname.replace(/\/+$/, "");
const tableNamePattern = "[a-z]+-[a-z]+-[a-z]+";

test("registers Guppycube with the Dev Hub and shows it on the dashboard", async ({ page, request }) => {
  const projectsResponse = await request.get(`${hubUrl}/api/projects`).catch(() => null);
  test.skip(projectsResponse === null, "The optional local Dev Hub is not running.");
  if (!projectsResponse) return;
  expect(projectsResponse.ok()).toBe(true);

  const payload = await projectsResponse.json() as {
    projects: Array<{ name: string; kind: string; url: string; healthUrl: string; root: string }>;
  };
  const exactProject = payload.projects.find((project) =>
    project.name === "guppycube" && new URL(project.url).origin === new URL(appUrl).origin
  );
  const registeredProject = exactProject ?? payload.projects.find((project) =>
    project.name === "guppycube" && project.root === process.cwd()
  );
  expect(registeredProject).toEqual(expect.objectContaining({
    name: "guppycube",
    kind: "cloudflare-vite",
  }));
  if (!exactProject) {
    test.info().annotations.push({
      type: "environment",
      description: "A pre-existing same-root listener owns the Dev Hub registration id; verified that registration and the requested listener independently.",
    });
  }
  const registeredUrl = new URL(registeredProject!.url);
  const registeredHealthUrl = new URL(registeredProject!.healthUrl);
  expect(["127.0.0.1", "localhost"]).toContain(registeredUrl.hostname);
  expect(registeredUrl.pathname).toBe("/");
  expect(registeredHealthUrl.origin).toBe(registeredUrl.origin);
  expect(registeredHealthUrl.pathname).toBe("/api/health");
  expect((await request.get(`${appUrl}/api/health`, { timeout: 5_000 })).ok()).toBe(true);
  expect((await request.get(registeredProject!.url, { timeout: 5_000 })).ok()).toBe(true);
  expect((await request.get(registeredProject!.healthUrl, { timeout: 5_000 })).ok()).toBe(true);

  await page.goto(hubUrl);
  await expect(page.getByRole("heading", { name: "Local Dev Hub" })).toBeVisible();

  const projectCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: "guppycube", exact: true }),
  }).filter({
    has: page.getByText(registeredProject!.root, { exact: true }),
  });
  await expect(projectCard).toBeVisible();
  const dashboardLink = projectCard.getByRole("link", { name: "guppycube", exact: true });
  const dashboardHref = await dashboardLink.getAttribute("href");
  expect(dashboardHref).not.toBeNull();
  const dashboardUrl = new URL(dashboardHref!, hubUrl);
  expect(["127.0.0.1", "localhost"]).toContain(dashboardUrl.hostname);
  expect((await request.get(dashboardUrl.href)).ok()).toBe(true);
  await expect(projectCard.getByText("cloudflare-vite", { exact: true })).toBeVisible();
  await expect(projectCard.getByText(registeredProject!.root, { exact: true })).toBeVisible();
});

test("exposes a searchable schema inventory and its validated API catalog", async ({ page, request }) => {
  const catalogResponse = await request.get(`${appUrl}/api/admin/schemas`);
  expect(catalogResponse.ok()).toBe(true);

  const catalog = await catalogResponse.json() as {
    schemas: Array<{
      key: string;
      category: "business" | "api" | "system";
      schemaId: string;
      schema: {
        $schema: string;
        $id: string;
        required?: string[];
        properties?: {
          roomCode?: { pattern?: string };
          assistPolicy?: {
            required?: string[];
            properties?: Record<string, { enum?: string[] }>;
          };
          assistId?: { enum?: string[] };
          enabled?: { type?: string };
          turnStartedAt?: { type?: string; minimum?: number };
          sequence?: { type?: string; minimum?: number };
          board?: { type?: string; maxItems?: number };
          turnDraft?: { anyOf?: Array<{ type?: string }> };
          myTurnDraft?: { anyOf?: Array<{ type?: string }> };
        };
      };
    }>;
    counts: Record<"business" | "api" | "system", number>;
  };
  expect(catalog.schemas.length).toBeGreaterThan(0);
  expect(catalog.counts.business).toBeGreaterThan(0);
  expect(catalog.counts.api).toBeGreaterThan(0);
  expect(catalog.counts.system).toBeGreaterThan(0);
  expect(catalog.schemas).toContainEqual(expect.objectContaining({
    key: "sessionCredentialsSchema",
    category: "system",
    schemaId: "https://guppycube.local/schemas/session-credentials-v2",
    schema: expect.objectContaining({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://guppycube.local/schemas/session-credentials-v2",
      properties: expect.objectContaining({
        roomCode: expect.objectContaining({ pattern: `^${tableNamePattern}$` }),
      }),
    }),
  }));
  expect(catalog.schemas).toContainEqual(expect.objectContaining({
    key: "createGameInputSchema",
    category: "api",
    schemaId: "https://guppycube.local/schemas/create-game-input",
    schema: expect.objectContaining({
      properties: expect.objectContaining({
        assistPolicy: expect.objectContaining({
          required: ["no-move-alert", "auto-draw", "rack-set-highlights"],
          properties: {
            "no-move-alert": { enum: ["default-on", "default-off", "disallowed"] },
            "auto-draw": { enum: ["default-on", "default-off", "disallowed"] },
            "rack-set-highlights": { enum: ["default-on", "default-off", "disallowed"] },
          },
        }),
      }),
    }),
  }));
  expect(catalog.schemas).toContainEqual(expect.objectContaining({
    key: "setAssistInputSchema",
    category: "api",
    schemaId: "https://guppycube.local/schemas/set-assist-input",
    schema: expect.objectContaining({
      properties: expect.objectContaining({
        assistId: { enum: ["no-move-alert", "auto-draw", "rack-set-highlights"] },
        enabled: { type: "boolean" },
      }),
    }),
  }));
  expect(catalog.schemas).toContainEqual(expect.objectContaining({
    key: "saveTurnDraftInputSchema",
    category: "api",
    schemaId: "https://guppycube.local/schemas/save-turn-draft-input",
    schema: expect.objectContaining({
      required: ["turnStartedAt", "sequence", "board"],
      properties: expect.objectContaining({
        turnStartedAt: { type: "integer", minimum: 0 },
        sequence: { type: "integer", minimum: 0 },
        board: expect.objectContaining({ type: "array", maxItems: 106 }),
      }),
    }),
  }));
  expect(catalog.schemas).toContainEqual(expect.objectContaining({
    key: "publicGameStateSchema",
    category: "business",
    schemaId: "https://guppycube.local/schemas/public-game-state-v2",
    schema: expect.objectContaining({
      required: expect.arrayContaining(["turnDraft", "myTurnDraft"]),
      properties: expect.objectContaining({
        turnDraft: expect.objectContaining({
          anyOf: expect.arrayContaining([
            expect.objectContaining({ type: "array" }),
            { type: "null" },
          ]),
        }),
        myTurnDraft: expect.objectContaining({
          anyOf: expect.arrayContaining([
            expect.objectContaining({ type: "array" }),
            { type: "null" },
          ]),
        }),
      }),
    }),
  }));

  await page.goto(`${appUrl}/admin/schemas`);
  await expect(page.getByRole("heading", { name: "Business objects" })).toBeVisible();
  await expect(page.locator("#summary")).toHaveText(/\d+ of \d+ schemas/);

  await page.getByRole("searchbox", { name: "Search schemas" }).fill("Session credentials");
  await expect(page.locator("#schemas article")).toHaveCount(1);
  const result = page.locator("#schemas article").first();
  await expect(result.getByRole("heading", { name: "Session credentials" })).toBeVisible();
  await expect(result).toContainText("browser cookie");
  await expect(result).toContainText("server-only room capability");

  await page.getByRole("searchbox", { name: "Search schemas" }).fill("Set assist input");
  await expect(page.locator("#schemas article")).toHaveCount(1);
  const assistResult = page.locator("#schemas article").first();
  await expect(assistResult.getByRole("heading", { name: "Set assist input" })).toBeVisible();
  await expect(assistResult).toContainText("no-move-alert");
  await expect(assistResult).toContainText("auto-draw");

  await page.getByRole("searchbox", { name: "Search schemas" }).fill("Save turn draft input");
  await expect(page.locator("#schemas article")).toHaveCount(1);
  const draftResult = page.locator("#schemas article").first();
  await expect(draftResult.getByRole("heading", { name: "Save turn draft input" })).toBeVisible();
  await expect(draftResult).toContainText("timeout resolution");
  await expect(draftResult).toContainText("turnStartedAt");
  await expect(draftResult).toContainText("sequence");
});

test("returns the validated JSON error envelope for an unknown schema API route", async ({ request }) => {
  const response = await request.get(`${appUrl}/api/admin/schemas/not-a-schema`);

  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["cache-control"]).toBe("no-store");
  await expect(response.json()).resolves.toEqual({
    error: "Not found.",
    code: "not_found",
  });
});

test("creates a shareable game and restores its room-scoped cookie session", async ({ page, context }) => {
  const playerName = `E2E ${Date.now().toString(36).slice(-8)}`;

  await page.goto(appUrl);
  await page.getByLabel("Your name").fill(playerName);
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/api/games")
  );
  await page.getByRole("button", { name: "Create table" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  await expect(page).toHaveURL(new RegExp(`${appUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/room/${tableNamePattern}$`));
  await expect(page.getByRole("heading", { name: /Bring in the competition/ })).toBeVisible();

  const roomCode = await page.locator(".invite-code strong").innerText();
  expect(roomCode).toMatch(new RegExp(`^${tableNamePattern}$`));
  await expect(createResponse.json()).resolves.toEqual({ roomCode });
  await expect(page.getByText(playerName, { exact: true })).toBeVisible();
  await expect(page.getByText("Host", { exact: true })).toBeVisible();

  const cookies = await context.cookies();
  const activeRoom = cookies.find((cookie) => cookie.name === "guppycube_active_room");
  const sessionCookie = cookies.find((cookie) => cookie.name === `guppycube_session_${roomCode}`);
  expect(activeRoom).toBeUndefined();
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe("Lax");
  expect(sessionCookie?.path).toBe(`${appBasePath}/api` || "/api");
  expect(await page.evaluate(() => document.cookie)).not.toContain(`guppycube_session_${roomCode}`);
  expect(await page.evaluate((code) => localStorage.getItem(`guppycube:session:${code}`), roomCode)).toBeNull();

  await page.reload();
  await expect(page).toHaveURL(`${appUrl}/room/${roomCode}`);
  await expect(page.getByText(roomCode, { exact: true })).toBeVisible();
  await expect(page.getByText(playerName, { exact: true })).toBeVisible();
});

test("opens an invite without a cookie, joins it, and rejects a legacy six-character code", async ({
  page,
  request,
  context,
}) => {
  const stamp = Date.now().toString(36).slice(-8);
  const hostName = `Host ${stamp}`;
  const guestName = `Guest ${stamp}`;
  const createResponse = await request.post(`${appUrl}/api/games`, {
    data: {
      name: hostName,
      mode: "realtime",
      maxPlayers: 4,
      assistPolicy: {
        "no-move-alert": "default-on",
        "auto-draw": "default-off",
        "rack-set-highlights": "default-off",
      },
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = await createResponse.json() as { roomCode: string };
  expect(created).toEqual({ roomCode: expect.stringMatching(new RegExp(`^${tableNamePattern}$`)) });
  const { roomCode } = created;
  expect(roomCode).toMatch(new RegExp(`^${tableNamePattern}$`));
  expect(await context.cookies(appUrl)).toEqual([]);

  await page.goto(`${appUrl}/room/${roomCode}`);
  await expect(page.getByRole("tab", { name: "Join a table" })).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Your name").fill(guestName);
  const tableName = page.getByLabel("Table name");
  await expect(tableName).toHaveValue(roomCode);

  await tableName.fill("ABCDEF");
  await expect(tableName).toHaveValue("abcdef");
  expect(await tableName.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  await page.getByRole("button", { name: "Take my seat" }).click();
  await expect(page).toHaveURL(`${appUrl}/room/${roomCode}`);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await tableName.fill(roomCode.toUpperCase().replaceAll("-", " "));
  await expect(tableName).toHaveValue(roomCode);
  const joinResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith(`/api/games/${roomCode}/join`)
  );
  await page.getByRole("button", { name: "Take my seat" }).click();
  const joinResponse = await joinResponsePromise;
  expect(joinResponse.status()).toBe(201);
  await expect(joinResponse.json()).resolves.toEqual({ roomCode });
  await expect(page).toHaveURL(`${appUrl}/room/${roomCode}`);
  await expect(page.getByText(roomCode, { exact: true })).toBeVisible();
  await expect(page.getByText(hostName, { exact: true })).toBeVisible();
  await expect(page.getByText(guestName, { exact: true })).toBeVisible();
});
