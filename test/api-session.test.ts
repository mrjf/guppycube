import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { app } from "../src/server";

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
