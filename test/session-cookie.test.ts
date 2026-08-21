import { describe, expect, test } from "vitest";
import type { SessionCredentials } from "../src/schemas";
import {
  decodeSessionCookie,
  encodeSessionCookie,
  sessionCookieName,
} from "../src/shared/session-cookie";

describe("room session cookies", () => {
  test("round-trips a room-scoped capability", () => {
    const session: SessionCredentials = {
      roomCode: "dorky-puppet-spam",
      playerId: "player-1",
      token: "a".repeat(64),
    };
    const cookie = `theme=dark; ${sessionCookieName(session.roomCode)}=${encodeSessionCookie(session)}; other=value`;
    expect(decodeSessionCookie(cookie, session.roomCode)).toEqual(session);
  });

  test("does not return another room's capability", () => {
    const session: SessionCredentials = {
      roomCode: "dorky-puppet-spam",
      playerId: "player-1",
      token: "a".repeat(64),
    };
    const cookie = `${sessionCookieName(session.roomCode)}=${encodeSessionCookie(session)}`;
    expect(decodeSessionCookie(cookie, "fuzzy-wizard-waffle")).toBeUndefined();
  });
});
