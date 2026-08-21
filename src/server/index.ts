import type { ValidateFunction } from "ajv";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { NONCE, secureHeaders, type SecureHeadersVariables } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { renderSchemaAdminPage } from "../schema-admin";
import { buildSchemaCatalogResponse } from "../schema-catalog";
import type {
  AddComputerInput,
  ApiError,
  CreateGameInput,
  GameSession,
  HealthResponse,
  OkResponse,
  RoomResult,
  SaveTurnDraftInput,
  SetAssistInput,
  SessionCredentials,
} from "../schemas";
import { decodeSessionCookie, encodeSessionCookie, sessionCookieName } from "../shared/session-cookie";
import { normalizeTableName } from "../shared/table-name";
import { describeValidationErrors, validators } from "../validation";
import { GameRoom, hashToken } from "./game-room";
import { makeTableName } from "./table-names";

export { GameRoom };

type AppEnv = { Bindings: Env; Variables: SecureHeadersVariables };
const deploymentBase = "/guppycube";

export const app = new Hono<AppEnv>();

app.use("*", requestId());
app.use("/api/*", secureHeaders());
app.use(
  "/admin/schemas",
  secureHeaders({
    contentSecurityPolicy: {
      baseUri: ["'none'"],
      connectSrc: ["'self'"],
      defaultSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: [NONCE],
      styleSrc: [NONCE],
    },
  }),
);
app.use("/api/*", bodyLimit({ maxSize: 32 * 1024 }));
app.use("/api/*", async (context, next) => {
  const origin = context.req.raw.headers.get("Origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(context.req.url).origin) {
        return errorJson(context, 403, "Cross-origin requests are not allowed.", "origin_not_allowed");
      }
    } catch {
      return errorJson(context, 403, "Cross-origin requests are not allowed.", "origin_not_allowed");
    }
  }
  await next();
});
app.use("/api/*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
});

function checkedJson<T>(
  context: Context<AppEnv>,
  validate: ValidateFunction<T>,
  body: T,
  status: ContentfulStatusCode = 200,
) {
  if (!validate(body)) {
    throw new Error(`Invalid server response: ${describeValidationErrors(validate.errors)}`);
  }
  return context.json(body, status);
}

function errorJson(context: Context<AppEnv>, status: ContentfulStatusCode, message: string, code?: string) {
  const body: ApiError = code ? { error: message, code } : { error: message };
  return checkedJson(context, validators.apiError, body, status);
}

function checkedRoomResult(value: unknown): RoomResult {
  if (!validators.roomResult(value)) {
    throw new Error(`Invalid game room response: ${describeValidationErrors(validators.roomResult.errors)}`);
  }
  return value;
}

function makeCredential(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRoomCode(value: string): string {
  return normalizeTableName(value);
}

function cookieSession(request: Request, roomCode: string): SessionCredentials | undefined {
  const value = decodeSessionCookie(request.headers.get("Cookie") ?? "", roomCode);
  return validators.sessionCredentials(value) && value.roomCode === roomCode ? value : undefined;
}

function setSessionCookie(context: Context<AppEnv>, session: SessionCredentials): void {
  const path = context.req.raw.headers.get("X-Guppycube-Base") === deploymentBase
    ? `${deploymentBase}/api`
    : "/api";
  const secure = new URL(context.req.url).protocol === "https:" ? "; Secure" : "";
  context.header(
    "Set-Cookie",
    `${sessionCookieName(session.roomCode)}=${encodeSessionCookie(session)}; Path=${path}; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
  );
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeName(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string") {
    return value;
  }
  return { ...value, name: value.name.trim() };
}

function isLocalRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLocaleLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

app.get("/api/health", (context) => {
  const body: HealthResponse = {
    ok: true,
    service: "guppycube",
    timestamp: new Date().toISOString(),
  };
  return checkedJson(context, validators.healthResponse, body);
});

app.get("/admin/schemas", (context) => {
  if (!isLocalRequest(context.req.raw)) return errorJson(context, 404, "Not found.", "not_found");
  return context.html(
    renderSchemaAdminPage({
      nonce: context.get("secureHeadersNonce") ?? "",
      siteTitle: "Guppycube",
    }),
  );
});

app.get("/api/admin/schemas", (context) => {
  if (!isLocalRequest(context.req.raw)) return errorJson(context, 404, "Not found.", "not_found");
  const body: unknown = buildSchemaCatalogResponse();
  if (!validators.schemaCatalogResponse(body)) {
    throw new Error(`Invalid schema catalog response: ${describeValidationErrors(validators.schemaCatalogResponse.errors)}`);
  }
  return checkedJson(context, validators.schemaCatalogResponse, body);
});

app.post("/api/games", async (context) => {
  const input = normalizeName(await parseJson(context.req.raw));
  if (!validators.createGameInput(input)) {
    return errorJson(
      context,
      400,
      describeValidationErrors(validators.createGameInput.errors),
      "invalid_game_settings",
    );
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = makeTableName();
    const playerId = crypto.randomUUID();
    const token = makeCredential();
    const tokenHash = await hashToken(token);
    const result = checkedRoomResult(
      await context.env.GAME_ROOMS.getByName(roomCode).create(
        roomCode,
        input satisfies CreateGameInput,
        playerId,
        tokenHash,
      ),
    );
    if (result.ok) {
      const credentials: SessionCredentials = { roomCode, playerId, token };
      setSessionCookie(context, credentials);
      const body: GameSession = { roomCode };
      return checkedJson(context, validators.gameSession, body, 201);
    }
  }
  return errorJson(context, 503, "Could not reserve a room code. Please try again.", "room_unavailable");
});

app.post("/api/games/:room/join", async (context) => {
  const roomCode = normalizeRoomCode(context.req.param("room"));
  const input = normalizeName(await parseJson(context.req.raw));
  if (!validators.joinGameInput(input)) {
    return errorJson(context, 400, describeValidationErrors(validators.joinGameInput.errors), "invalid_name");
  }

  const playerId = crypto.randomUUID();
  const token = makeCredential();
  const tokenHash = await hashToken(token);
  const result = checkedRoomResult(
    await context.env.GAME_ROOMS.getByName(roomCode).join(input.name, playerId, tokenHash),
  );
  if (!result.ok) return errorJson(context, 409, result.error ?? "Could not join that game.", "join_failed");
  const credentials: SessionCredentials = { roomCode, playerId, token };
  setSessionCookie(context, credentials);
  const body: GameSession = { roomCode };
  return checkedJson(context, validators.gameSession, body, 201);
});

app.post("/api/games/:room/computers", async (context) => {
  const roomCode = normalizeRoomCode(context.req.param("room"));
  const input = await parseJson(context.req.raw);
  if (!validators.addComputerInput(input)) {
    return errorJson(context, 400, describeValidationErrors(validators.addComputerInput.errors), "invalid_computer");
  }
  const request = input satisfies AddComputerInput;
  const identity = cookieSession(context.req.raw, roomCode);
  if (!identity) return errorJson(context, 401, "That player session is not valid.", "invalid_session");
  const result = checkedRoomResult(
    await context.env.GAME_ROOMS.getByName(roomCode).addComputer(identity.playerId, identity.token, request.strategy),
  );
  if (!result.ok) return errorJson(context, 409, result.error ?? "Could not add a computer player.", "add_computer_failed");
  const body: OkResponse = { ok: true };
  return checkedJson(context, validators.okResponse, body, 201);
});

app.post("/api/games/:room/assists", async (context) => {
  const roomCode = normalizeRoomCode(context.req.param("room"));
  const input = await parseJson(context.req.raw);
  if (!validators.setAssistInput(input)) {
    return errorJson(context, 400, describeValidationErrors(validators.setAssistInput.errors), "invalid_assist");
  }
  const request = input satisfies SetAssistInput;
  const identity = cookieSession(context.req.raw, roomCode);
  if (!identity) return errorJson(context, 401, "That player session is not valid.", "invalid_session");
  const result = checkedRoomResult(
    await context.env.GAME_ROOMS.getByName(roomCode).setAssist(
      identity.playerId,
      identity.token,
      request.assistId,
      request.enabled,
    ),
  );
  if (!result.ok) return errorJson(context, 409, result.error ?? "Could not update that assist.", "assist_not_allowed");
  const body: OkResponse = { ok: true };
  return checkedJson(context, validators.okResponse, body);
});

app.get("/api/games/:room", async (context) => {
  const roomCode = normalizeRoomCode(context.req.param("room"));
  const identity = cookieSession(context.req.raw, roomCode);
  if (!identity) return errorJson(context, 401, "That player session is not valid.", "invalid_session");
  try {
    const state = await context.env.GAME_ROOMS.getByName(roomCode).getPublicState(identity.playerId, identity.token);
    return checkedJson(context, validators.publicGameState, state);
  } catch (error) {
    return errorJson(
      context,
      401,
      error instanceof Error ? error.message : "Could not load the game.",
      "invalid_session",
    );
  }
});

app.post("/api/games/:room/start", async (context) => {
  const roomCode = normalizeRoomCode(context.req.param("room"));
  const input = await parseJson(context.req.raw);
  if (!validators.startGameInput(input)) {
    return errorJson(context, 400, describeValidationErrors(validators.startGameInput.errors), "invalid_start");
  }
  const identity = cookieSession(context.req.raw, roomCode);
  if (!identity) return errorJson(context, 401, "That player session is not valid.", "invalid_session");
  const result = checkedRoomResult(
    await context.env.GAME_ROOMS.getByName(roomCode).start(identity.playerId, identity.token),
  );
  if (!result.ok) return errorJson(context, 409, result.error ?? "Could not start the game.", "start_failed");
  const body: OkResponse = { ok: true };
  return checkedJson(context, validators.okResponse, body);
});

app.post("/api/games/:room/action", async (context) => {
  const roomCode = normalizeRoomCode(context.req.param("room"));
  const input = await parseJson(context.req.raw);
  if (!validators.takeActionInput(input)) {
    return errorJson(context, 400, describeValidationErrors(validators.takeActionInput.errors), "invalid_action");
  }
  const identity = cookieSession(context.req.raw, roomCode);
  if (!identity) return errorJson(context, 401, "That player session is not valid.", "invalid_session");
  const result = checkedRoomResult(
    await context.env.GAME_ROOMS.getByName(roomCode).act(identity.playerId, identity.token, input.action),
  );
  if (!result.ok) return errorJson(context, 409, result.error ?? "That move is not legal.", "illegal_move");
  const body: OkResponse = { ok: true };
  return checkedJson(context, validators.okResponse, body);
});

app.put("/api/games/:room/draft", async (context) => {
  const roomCode = normalizeRoomCode(context.req.param("room"));
  const input = await parseJson(context.req.raw);
  if (!validators.saveTurnDraftInput(input)) {
    return errorJson(context, 400, describeValidationErrors(validators.saveTurnDraftInput.errors), "invalid_turn_draft");
  }
  const request = input satisfies SaveTurnDraftInput;
  const identity = cookieSession(context.req.raw, roomCode);
  if (!identity) return errorJson(context, 401, "That player session is not valid.", "invalid_session");
  const result = checkedRoomResult(
    await context.env.GAME_ROOMS.getByName(roomCode).saveTurnDraft(identity.playerId, identity.token, request),
  );
  if (!result.ok) return errorJson(context, 409, result.error ?? "Could not save that turn draft.", "turn_draft_rejected");
  const body: OkResponse = { ok: true };
  return checkedJson(context, validators.okResponse, body);
});

app.get("/api/games/:room/ws", async (context) => {
  const roomCode = normalizeRoomCode(context.req.param("room"));
  return context.env.GAME_ROOMS.getByName(roomCode).fetch(context.req.raw);
});

app.notFound((context) => {
  if (context.req.path.startsWith("/api/")) return errorJson(context, 404, "Not found.", "not_found");
  return context.env.ASSETS.fetch(context.req.raw);
});

app.onError((error, context) => {
  console.error(
    JSON.stringify({
      message: "request failed",
      path: context.req.path,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return errorJson(context, 500, "Internal server error.", "internal_error");
});

function withoutDeploymentBase(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname !== deploymentBase && !url.pathname.startsWith(`${deploymentBase}/`)) return request;
  url.pathname = url.pathname.slice(deploymentBase.length) || "/";
  const rewritten = new Request(url, request);
  rewritten.headers.set("X-Guppycube-Base", deploymentBase);
  return rewritten;
}

export default {
  fetch(request, env, executionContext) {
    return app.fetch(withoutDeploymentBase(request), env, executionContext);
  },
} satisfies ExportedHandler<Env>;
