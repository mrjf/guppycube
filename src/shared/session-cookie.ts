import type { SessionCredentials } from "../schemas";
import { normalizeTableName } from "./table-name";

const SESSION_COOKIE_PREFIX = "guppycube_session_";

export function sessionCookieName(roomCode: string): string {
  return `${SESSION_COOKIE_PREFIX}${normalizeTableName(roomCode)}`;
}

export function encodeSessionCookie(session: SessionCredentials): string {
  return encodeURIComponent(JSON.stringify(session));
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
