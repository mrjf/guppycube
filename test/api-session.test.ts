import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { app } from "../src/server";
import { decodeSessionCookie } from "../src/shared/session-cookie";

function gameRequest(path: string, init?: RequestInit): Promise<Response> {
  return app.request(`http://127.0.0.1${path}`, init, env);
}

describe("cookie-authenticated game API", () => {
  test("returns only a room reference and keeps credentials in an HttpOnly API cookie", async () => {
    const create = await gameRequest("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ name: "Cookie Host", mode: "realtime", maxPlayers: 2 }),
    });

    expect(create.status).toBe(201);
    const session = await create.json<{ roomCode: string }>();
    expect(session).toEqual({ roomCode: expect.stringMatching(/^[a-z]+-[a-z]+-[a-z]+$/) });
    expect(JSON.stringify(session)).not.toContain("token");
    expect(JSON.stringify(session)).not.toContain("playerId");

    const setCookie = create.headers.get("Set-Cookie");
    expect(setCookie).toContain(`guppycube_session_${session.roomCode}=`);
    expect(setCookie).toContain("Path=/api");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie!.split(";", 1)[0]!;

    const state = await gameRequest(`/api/games/${session.roomCode}`, {
      headers: { Cookie: cookie },
    });
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toEqual(expect.objectContaining({ id: session.roomCode }));

    const addComputer = await gameRequest(`/api/games/${session.roomCode}/computers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ strategy: "basic" }),
    });
    expect(addComputer.status).toBe(201);

    const start = await gameRequest(`/api/games/${session.roomCode}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(200);
  });

  test("does not accept identity from query parameters, request bodies, or bearer tokens", async () => {
    const roomCode = "dorky-puppet-spam";
    const get = await gameRequest(`/api/games/${roomCode}?player=player-1`, {
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    });
    expect(get.status).toBe(401);

    const action = await gameRequest(`/api/games/${roomCode}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${"a".repeat(64)}` },
      body: JSON.stringify({ playerId: "player-1", action: { type: "draw" } }),
    });
    expect(action.status).toBe(400);
  });

  test("authenticates a portable player link without a cookie", async () => {
    const create = await gameRequest("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ name: "Portable Host", mode: "realtime", maxPlayers: 2 }),
    });
    const session = await create.json<{ roomCode: string }>();
    const cookie = create.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const credentials = decodeSessionCookie(cookie, session.roomCode) as {
      playerId: string;
      token: string;
    };
    const player = `${credentials.playerId}.${credentials.token}`;

    const portableState = await gameRequest(
      `/api/games/${session.roomCode}?player=${encodeURIComponent(player)}`,
    );
    expect(portableState.status).toBe(200);
    expect(portableState.headers.get("Set-Cookie")).toContain(`guppycube_session_${session.roomCode}=`);
    await expect(portableState.json()).resolves.toEqual(expect.objectContaining({
      myPlayerId: credentials.playerId,
    }));

    const linkResponse = await gameRequest(
      `/api/games/${session.roomCode}/link?player=${encodeURIComponent(player)}`,
    );
    expect(linkResponse.status).toBe(200);
    const link = await linkResponse.json<{ link: string }>();
    expect(new URL(link.link).searchParams.get("player")).toBe(player);
  });

  test("lets the host create a rejoin link that authenticates another player in a fresh browser", async () => {
    const create = await gameRequest("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ name: "Rejoin Host", mode: "correspondence", maxPlayers: 2 }),
    });
    expect(create.status).toBe(201);
    const session = await create.json<{ roomCode: string }>();
    const hostCookie = create.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const hostCredentials = decodeSessionCookie(hostCookie, session.roomCode) as {
      playerId: string;
      token: string;
    };

    const join = await gameRequest(`/api/games/${session.roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ name: "Rejoin Guest" }),
    });
    expect(join.status).toBe(201);
    const guestCookie = join.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const guestCredentials = decodeSessionCookie(guestCookie, session.roomCode) as {
      playerId: string;
      token: string;
    };
    expect(guestCredentials.playerId).not.toBe(hostCredentials.playerId);

    const rejoin = await gameRequest(
      `/api/games/${session.roomCode}/players/${encodeURIComponent(guestCredentials.playerId)}/rejoin-link`,
      { method: "POST", headers: { Cookie: hostCookie } },
    );
    expect(rejoin.status).toBe(201);
    const payload = await rejoin.json<{ link: string }>();
    const link = new URL(payload.link);
    expect(link.pathname).toBe(`/room/${session.roomCode}`);
    const player = link.searchParams.get("player");
    expect(player).toBeTruthy();
    const playerSeparator = player!.indexOf(".");
    const linkedPlayerId = player!.slice(0, playerSeparator);
    const linkedToken = player!.slice(playerSeparator + 1);
    expect(playerSeparator).toBeGreaterThan(0);
    expect(linkedPlayerId).toBe(guestCredentials.playerId);
    expect(linkedPlayerId).not.toBe(hostCredentials.playerId);
    expect(linkedToken).toBeTruthy();

    const freshState = await gameRequest(`/api/games/${session.roomCode}${link.search}`);
    expect(freshState.status).toBe(200);
    const restoredCookie = freshState.headers.get("Set-Cookie");
    expect(restoredCookie).toContain(`guppycube_session_${session.roomCode}=`);
    expect(decodeSessionCookie(restoredCookie ?? "", session.roomCode)).toEqual({
      roomCode: session.roomCode,
      playerId: guestCredentials.playerId,
      token: linkedToken,
    });
    await expect(freshState.json()).resolves.toEqual(expect.objectContaining({
      id: session.roomCode,
      myPlayerId: guestCredentials.playerId,
    }));

    const originalGuestState = await gameRequest(`/api/games/${session.roomCode}`, {
      headers: { Cookie: guestCookie },
    });
    expect(originalGuestState.status).toBe(200);
    await expect(originalGuestState.json()).resolves.toEqual(expect.objectContaining({
      myPlayerId: guestCredentials.playerId,
    }));
  });

  test("does not let a non-host create another player's rejoin link", async () => {
    const create = await gameRequest("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ name: "Protected Host", mode: "realtime", maxPlayers: 2 }),
    });
    const session = await create.json<{ roomCode: string }>();
    const hostCookie = create.headers.get("Set-Cookie")!.split(";", 1)[0]!;
    const hostCredentials = decodeSessionCookie(hostCookie, session.roomCode) as { playerId: string };

    const join = await gameRequest(`/api/games/${session.roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ name: "Protected Guest" }),
    });
    const guestCookie = join.headers.get("Set-Cookie")!.split(";", 1)[0]!;

    const response = await gameRequest(
      `/api/games/${session.roomCode}/players/${encodeURIComponent(hostCredentials.playerId)}/rejoin-link`,
      { method: "POST", headers: { Cookie: guestCookie } },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      error: expect.stringMatching(/host/i),
      code: "host_required",
    }));
  });

  test("lists every room identified by the browser's session cookies", async () => {
    const first = await gameRequest("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ name: "History Host", mode: "realtime", maxPlayers: 2 }),
    });
    const firstSession = await first.json<{ roomCode: string }>();
    const firstCookie = first.headers.get("Set-Cookie")!.split(";", 1)[0]!;

    const second = await gameRequest("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ name: "History Host Two", mode: "correspondence", maxPlayers: 3 }),
    });
    const secondSession = await second.json<{ roomCode: string }>();
    const secondCookie = second.headers.get("Set-Cookie")!.split(";", 1)[0]!;

    const history = await gameRequest("/api/games/history", {
      headers: { Cookie: `${firstCookie}; ${secondCookie}` },
    });
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toEqual({
      games: expect.arrayContaining([
        expect.objectContaining({ id: firstSession.roomCode, status: "lobby", players: [{ name: "History Host", isComputer: false }] }),
        expect.objectContaining({ id: secondSession.roomCode, status: "lobby", players: [{ name: "History Host Two", isComputer: false }] }),
      ]),
    });
  });

  test("rejects cross-origin browser requests", async () => {
    const response = await gameRequest("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ name: "Mallory", mode: "realtime", maxPlayers: 2 }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin requests are not allowed.",
      code: "origin_not_allowed",
    });
  });

  test("scopes secure production cookies to the deployed API path", async () => {
    const response = await app.request("https://snagsby.com/api/games", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Guppycube-Base": "/guppycube",
      },
      body: JSON.stringify({ name: "Production Host", mode: "correspondence", maxPlayers: 2 }),
    }, env);

    expect(response.status).toBe(201);
    expect(response.headers.get("Set-Cookie")).toContain("Path=/guppycube/api");
    expect(response.headers.get("Set-Cookie")).toContain("Secure");
  });
});
