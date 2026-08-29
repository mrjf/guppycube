import type { SessionCredentials } from "../schemas";
import { normalizeTableName } from "./table-name";

const SESSION_COOKIE_PREFIX = "guppycube_session_";

export function sessionCookieName(roomCode: string): string {
  return `${SESSION_COOKIE_PREFIX}${normalizeTableName(roomCode)}`;
}

export function encodeSessionCookie(session: SessionCredentials): string {
  return encodeURIComponent(JSON.stringify(session));
}

export function encodePlayerLink(session: SessionCredentials): string {
  return `${session.playerId}.${session.token}`;
}

export function decodePlayerLink(value: string | null | undefined, roomCode: string): unknown {
  if (!value) return undefined;
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return {
    roomCode: normalizeTableName(roomCode),
    playerId: value.slice(0, separator),
    token: value.slice(separator + 1),
  };
}

export function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function decodeSessionCookie(cookieHeader: string, roomCode: string): unknown {
  const encoded = readCookie(cookieHeader, sessionCookieName(roomCode));
  if (!encoded) return undefined;
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    return undefined;
  }
}

export function decodeSessionCookies(cookieHeader: string): unknown[] {
  const sessions: unknown[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name.startsWith(SESSION_COOKIE_PREFIX)) continue;
    const roomCode = name.slice(SESSION_COOKIE_PREFIX.length);
    if (!roomCode) continue;
    const encoded = part.slice(separator + 1).trim();
    try {
      sessions.push(JSON.parse(decodeURIComponent(encoded)));
    } catch {
      // Ignore malformed room cookies while preserving the valid ones.
    }
  }
  return sessions;
}
