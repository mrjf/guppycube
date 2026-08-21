import type { ValidateFunction } from "ajv";
import type {
  ComputerStrategyId,
  CreateGameInput,
  GameSession,
  OkResponse,
  PublicGameState,
  SaveTurnDraftInput,
  SetAssistInput,
  TurnAction,
} from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { appPath } from "./base-path";

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(url: string, validate: ValidateFunction<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin" });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A proxy or platform failure may return a non-JSON response.
  }
  if (!response.ok) {
    const message = validators.apiError(payload) ? payload.error : "Request failed.";
    throw new ApiRequestError(message, response.status);
  }
  if (!validate(payload)) {
    throw new Error(`The server returned an invalid response: ${describeValidationErrors(validate.errors)}`);
  }
  return payload;
}

export async function createGame(input: CreateGameInput): Promise<GameSession> {
  return request(appPath("/api/games"), validators.gameSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function joinGame(roomCode: string, name: string): Promise<GameSession> {
  return request(appPath(`/api/games/${roomCode}/join`), validators.gameSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function getGame(session: GameSession): Promise<PublicGameState> {
  return request(appPath(`/api/games/${session.roomCode}`), validators.publicGameState, {
    credentials: "same-origin",
  });
}

export async function startGame(session: GameSession): Promise<void> {
  await request<OkResponse>(appPath(`/api/games/${session.roomCode}/start`), validators.okResponse, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
}

export async function addComputer(session: GameSession, strategy: ComputerStrategyId): Promise<void> {
  await request<OkResponse>(appPath(`/api/games/${session.roomCode}/computers`), validators.okResponse, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ strategy }),
  });
}

export async function setAssist(session: GameSession, input: SetAssistInput): Promise<void> {
  await request<OkResponse>(appPath(`/api/games/${session.roomCode}/assists`), validators.okResponse, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function takeAction(session: GameSession, action: TurnAction): Promise<void> {
  await request<OkResponse>(appPath(`/api/games/${session.roomCode}/action`), validators.okResponse, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action }),
  });
}

export async function saveTurnDraft(session: GameSession, input: SaveTurnDraftInput): Promise<void> {
  await request<OkResponse>(appPath(`/api/games/${session.roomCode}/draft`), validators.okResponse, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export function socketUrl(session: GameSession): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${appPath(`/api/games/${session.roomCode}/ws`)}`;
}
