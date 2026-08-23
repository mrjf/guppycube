import type { FromSchema } from "json-schema-to-ts";
import { ASSIST_IDS, ASSIST_POLICIES } from "./shared/assists";
import { TABLE_NAME_PATTERN } from "./shared/table-name";

const dialect = "https://json-schema.org/draft/2020-12/schema" as const;
const identifier = { type: "string", minLength: 1, maxLength: 80 } as const;
const timestamp = { type: "integer", minimum: 0 } as const;
const nullableTimestamp = { type: ["integer", "null"], minimum: 0 } as const;
const nullableIdentifier = { type: ["string", "null"], minLength: 1, maxLength: 80 } as const;
const gameModes = ["realtime", "correspondence"] as const;
const gameStatuses = ["lobby", "playing", "finished"] as const;
const eventKinds = ["created", "joined", "started", "played", "drew", "timeout", "won"] as const;

export const TILE_COLORS = ["coral", "sun", "ocean", "ink"] as const;
export const TILE_NUMBER_MIN = 1;
export const TILE_NUMBER_MAX = 13;
export const TILE_COPIES_PER_NUMBER_AND_COLOR = 2;
export const WILDCARD_TILE_COUNT = 2;
export const TILE_SET_SIZE = TILE_COLORS.length
  * (TILE_NUMBER_MAX - TILE_NUMBER_MIN + 1)
  * TILE_COPIES_PER_NUMBER_AND_COLOR
  + WILDCARD_TILE_COUNT;
export const COMPUTER_STRATEGIES = ["basic"] as const;

const nullableComputerStrategy = {
  anyOf: [{ enum: COMPUTER_STRATEGIES }, { type: "null" }],
} as const;

const assistIdShape = { enum: ASSIST_IDS } as const;
const enabledAssistsShape = {
  type: "array",
  items: assistIdShape,
  uniqueItems: true,
  maxItems: ASSIST_IDS.length,
} as const;
type AssistPolicyProperties = {
  readonly [AssistId in (typeof ASSIST_IDS)[number]]: { readonly enum: typeof ASSIST_POLICIES };
};
const assistPolicyProperties = Object.fromEntries(
  ASSIST_IDS.map((assistId) => [assistId, { enum: ASSIST_POLICIES }]),
) as AssistPolicyProperties;
const assistPolicyShape = {
  type: "object",
  additionalProperties: false,
  properties: assistPolicyProperties,
  required: ASSIST_IDS,
} as const;

const tileShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: identifier,
    color: { anyOf: [{ enum: TILE_COLORS }, { type: "null" }] },
    value: { anyOf: [{ type: "integer", minimum: TILE_NUMBER_MIN, maximum: TILE_NUMBER_MAX }, { type: "null" }] },
    wildcard: { type: "boolean" },
  },
  required: ["id", "color", "value", "wildcard"],
} as const;

const meldShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: identifier,
    tileIds: { type: "array", items: identifier, minItems: 1, maxItems: TILE_NUMBER_MAX },
  },
  required: ["id", "tileIds"],
} as const;

const turnDraftShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    playerId: identifier,
    turnStartedAt: timestamp,
    sequence: timestamp,
    board: { type: "array", items: meldShape, maxItems: TILE_SET_SIZE },
  },
  required: ["playerId", "turnStartedAt", "sequence", "board"],
} as const;

const publicPlayerShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: identifier,
    name: { type: "string", minLength: 1, maxLength: 20 },
    rackCount: { type: "integer", minimum: 0, maximum: TILE_SET_SIZE },
    rackTileIds: { type: "array", items: identifier, maxItems: TILE_SET_SIZE },
    opened: { type: "boolean" },
    connected: { type: "boolean" },
    isHost: { type: "boolean" },
    isComputer: { type: "boolean" },
    computerStrategy: nullableComputerStrategy,
  },
  required: ["id", "name", "rackCount", "rackTileIds", "opened", "connected", "isHost", "isComputer", "computerStrategy"],
} as const;

const gameEventShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: identifier,
    at: timestamp,
    playerId: nullableIdentifier,
    kind: { enum: eventKinds },
    message: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["id", "at", "playerId", "kind", "message"],
} as const;

const scoreShape = {
  anyOf: [
    { type: "object", additionalProperties: { type: "integer" } },
    { type: "null" },
  ],
} as const;

const storedPlayerShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: identifier,
    name: { type: "string", minLength: 1, maxLength: 20 },
    tokenHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    rack: { type: "array", items: identifier, maxItems: TILE_SET_SIZE },
    opened: { type: "boolean" },
    joinedAt: timestamp,
    isComputer: { type: "boolean" },
    computerStrategy: nullableComputerStrategy,
    enabledAssists: enabledAssistsShape,
  },
  required: ["id", "name", "tokenHash", "rack", "opened", "joinedAt", "isComputer", "computerStrategy", "enabledAssists"],
} as const;

const turnActionVariants = [
  {
    type: "object",
    additionalProperties: false,
    properties: { type: { const: "draw" } },
    required: ["type"],
  },
  {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: "commit" },
      board: { type: "array", items: meldShape, maxItems: TILE_SET_SIZE },
    },
    required: ["type", "board"],
  },
] as const;

const apiErrorShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: "string", minLength: 1, maxLength: 500 },
    code: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 80 },
  },
  required: ["error"],
} as const;

export const tileSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/tile",
  ...tileShape,
} as const;

export const meldSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/meld",
  ...meldShape,
} as const;

export const publicPlayerSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/public-player",
  ...publicPlayerShape,
} as const;

export const gameEventSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/game-event",
  ...gameEventShape,
} as const;

const publicGameStateShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: identifier,
    version: { type: "integer", minimum: 1 },
    mode: { enum: gameModes },
    status: { enum: gameStatuses },
    maxPlayers: { type: "integer", minimum: 2, maximum: 4 },
    createdAt: timestamp,
    updatedAt: timestamp,
    turnStartedAt: nullableTimestamp,
    turnDeadline: nullableTimestamp,
    currentPlayerId: nullableIdentifier,
    winnerId: nullableIdentifier,
    poolCount: { type: "integer", minimum: 0, maximum: TILE_SET_SIZE },
    board: { type: "array", items: meldShape, maxItems: TILE_SET_SIZE },
    players: { type: "array", items: publicPlayerShape, minItems: 1, maxItems: 4 },
    myPlayerId: identifier,
    myRack: { type: "array", items: identifier, maxItems: TILE_SET_SIZE },
    turnDraft: { anyOf: [{ type: "array", items: meldShape, maxItems: TILE_SET_SIZE }, { type: "null" }] },
    myTurnDraft: { anyOf: [{ type: "array", items: meldShape, maxItems: TILE_SET_SIZE }, { type: "null" }] },
    tiles: { type: "object", additionalProperties: tileShape, maxProperties: TILE_SET_SIZE },
    history: { type: "array", items: gameEventShape, maxItems: 12 },
    scores: scoreShape,
    assistPolicy: assistPolicyShape,
    enabledAssists: enabledAssistsShape,
    noMovePossible: { type: "boolean" },
  },
  required: [
    "id",
    "version",
    "mode",
    "status",
    "maxPlayers",
    "createdAt",
    "updatedAt",
    "turnStartedAt",
    "turnDeadline",
    "currentPlayerId",
    "winnerId",
    "poolCount",
    "board",
    "players",
    "myPlayerId",
    "myRack",
    "turnDraft",
    "myTurnDraft",
    "tiles",
    "history",
    "scores",
    "assistPolicy",
    "enabledAssists",
    "noMovePossible",
  ],
} as const;

export const publicGameStateSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/public-game-state-v2",
  ...publicGameStateShape,
} as const;

export const storedPlayerSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/stored-player",
  ...storedPlayerShape,
} as const;

export const storedGameSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/stored-game",
  type: "object",
  additionalProperties: false,
  properties: {
    id: identifier,
    version: { type: "integer", minimum: 1 },
    mode: { enum: gameModes },
    status: { enum: gameStatuses },
    maxPlayers: { type: "integer", minimum: 2, maximum: 4 },
    hostPlayerId: identifier,
    createdAt: timestamp,
    updatedAt: timestamp,
    turnStartedAt: nullableTimestamp,
    turnDeadline: nullableTimestamp,
    turnDurationMs: { type: "integer", minimum: 1 },
    turnIndex: { type: "integer", minimum: 0, maximum: 3 },
    winnerId: nullableIdentifier,
    players: { type: "array", items: storedPlayerShape, minItems: 1, maxItems: 4 },
    pool: { type: "array", items: identifier, maxItems: TILE_SET_SIZE },
    board: { type: "array", items: meldShape, maxItems: TILE_SET_SIZE },
    tiles: { type: "object", additionalProperties: tileShape, maxProperties: TILE_SET_SIZE },
    history: { type: "array", items: gameEventShape, maxItems: 40 },
    scores: scoreShape,
    consecutiveEmptyDraws: { type: "integer", minimum: 0, maximum: 4 },
    assistPolicy: assistPolicyShape,
    turnDraft: { anyOf: [turnDraftShape, { type: "null" }] },
  },
  required: [
    "id",
    "version",
    "mode",
    "status",
    "maxPlayers",
    "hostPlayerId",
    "createdAt",
    "updatedAt",
    "turnStartedAt",
    "turnDeadline",
    "turnIndex",
    "winnerId",
    "players",
    "pool",
    "board",
    "tiles",
    "history",
    "scores",
    "consecutiveEmptyDraws",
    "assistPolicy",
    "turnDraft",
  ],
} as const;

export const createGameInputSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/create-game-input",
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 20, pattern: "\\S" },
    mode: { enum: gameModes },
    maxPlayers: { type: "integer", minimum: 2, maximum: 4 },
    assistPolicy: assistPolicyShape,
  },
  required: ["name", "mode", "maxPlayers"],
} as const;

export const setAssistInputSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/set-assist-input",
  type: "object",
  additionalProperties: false,
  properties: {
    assistId: assistIdShape,
    enabled: { type: "boolean" },
  },
  required: ["assistId", "enabled"],
} as const;

export const joinGameInputSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/join-game-input",
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 20, pattern: "\\S" },
  },
  required: ["name"],
} as const;

export const addComputerInputSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/add-computer-input",
  type: "object",
  additionalProperties: false,
  properties: {
    strategy: { enum: COMPUTER_STRATEGIES },
  },
  required: ["strategy"],
} as const;

export const startGameInputSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/start-game-input",
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [],
} as const;

export const turnActionSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/turn-action",
  type: "object",
  oneOf: turnActionVariants,
} as const;

export const takeActionInputSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/take-action-input",
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "object", oneOf: turnActionVariants },
  },
  required: ["action"],
} as const;

export const saveTurnDraftInputSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/save-turn-draft-input",
  type: "object",
  additionalProperties: false,
  properties: {
    turnStartedAt: timestamp,
    sequence: timestamp,
    board: { type: "array", items: meldShape, maxItems: TILE_SET_SIZE },
  },
  required: ["turnStartedAt", "sequence", "board"],
} as const;

export const gameSessionSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/game-session-v1",
  type: "object",
  additionalProperties: false,
  properties: {
    roomCode: { type: "string", pattern: TABLE_NAME_PATTERN },
  },
  required: ["roomCode"],
} as const;

export const sessionCredentialsSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/session-credentials-v2",
  type: "object",
  additionalProperties: false,
  properties: {
    roomCode: { type: "string", pattern: TABLE_NAME_PATTERN },
    playerId: identifier,
    token: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  required: ["roomCode", "playerId", "token"],
} as const;

export const okResponseSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/ok-response",
  type: "object",
  additionalProperties: false,
  properties: { ok: { const: true } },
  required: ["ok"],
} as const;

export const healthResponseSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/health-response",
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { const: true },
    service: { const: "guppycube" },
    timestamp: { type: "string", format: "date-time" },
  },
  required: ["ok", "service", "timestamp"],
} as const;

export const apiErrorSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/api-error",
  ...apiErrorShape,
} as const;

export const roomResultSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/room-result",
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    error: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["ok"],
} as const;

export const serverSocketMessageSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/server-socket-message",
  type: "object",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: { type: { const: "state" }, state: publicGameStateShape },
      required: ["type", "state"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { type: { const: "error" }, error: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["type", "error"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { type: { const: "pong" }, at: timestamp },
      required: ["type", "at"],
    },
  ],
} as const;

export const clientSocketMessageSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/client-socket-message",
  type: "object",
  additionalProperties: false,
  properties: { type: { const: "ping" } },
  required: ["type"],
} as const;

export const hubDiscoverySchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/dev-hub-discovery",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    url: { type: "string", format: "uri" },
    token: { type: "string", minLength: 32, maxLength: 256 },
    pid: { type: "integer", minimum: 1 },
    startedAt: { type: "string", format: "date-time" },
  },
  required: ["schemaVersion", "url", "token", "pid", "startedAt"],
} as const;

export const devProjectSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/dev-project",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 3, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 120 },
    kind: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 80 },
    url: { type: "string", format: "uri" },
    healthUrl: { type: "string", format: "uri" },
    root: { type: "string", minLength: 1, maxLength: 4096 },
    pid: { type: "integer", minimum: 1 },
    startedAt: { type: "string", format: "date-time" },
    runtime: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { enum: ["bun", "node"] },
        version: { type: "string", minLength: 1, maxLength: 40 },
      },
      required: ["name", "version"],
    },
  },
  required: ["schemaVersion", "id", "name", "kind", "url", "healthUrl", "root", "pid", "startedAt", "runtime"],
} as const;

export const registrationResponseSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/dev-project-registration-response",
  type: "object",
  additionalProperties: false,
  properties: {
    accepted: { const: true },
    id: { type: "string", minLength: 3, maxLength: 200 },
    lastSeen: { type: "string", format: "date-time" },
    ttlMs: { type: "integer", minimum: 1_000, maximum: 300_000 },
  },
  required: ["accepted", "id", "lastSeen", "ttlMs"],
} as const;

export const unregisterRequestSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/dev-project-unregister-request",
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string", minLength: 3, maxLength: 200 } },
  required: ["id"],
} as const;

export const unregisterResponseSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/dev-project-unregister-response",
  type: "object",
  additionalProperties: false,
  properties: {
    removed: { type: "boolean" },
    id: { type: "string", minLength: 3, maxLength: 200 },
  },
  required: ["removed", "id"],
} as const;

const schemaDocumentShape = {
  type: "object",
  additionalProperties: true,
  properties: {
    $schema: { type: "string", format: "uri" },
    $id: { type: "string", format: "uri" },
    type: { type: "string", minLength: 1 },
  },
  required: ["$schema", "$id", "type"],
} as const;

const schemaCatalogEntryShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", pattern: "^[a-z][a-zA-Z0-9]*$" },
    title: { type: "string", minLength: 1, maxLength: 120 },
    typeName: { type: "string", pattern: "^[A-Z][a-zA-Z0-9]*$" },
    category: { enum: ["business", "api", "system"] },
    description: { type: "string", minLength: 1, maxLength: 500 },
    schemaId: { type: "string", format: "uri" },
    schema: schemaDocumentShape,
  },
  required: ["key", "title", "typeName", "category", "description", "schemaId", "schema"],
} as const;

export const schemaDocumentSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/schema-document",
  ...schemaDocumentShape,
} as const;

export const schemaCatalogEntrySchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/schema-catalog-entry",
  ...schemaCatalogEntryShape,
} as const;

export const schemaCatalogResponseSchema = {
  $schema: dialect,
  $id: "https://guppycube.local/schemas/schema-catalog-response",
  type: "object",
  additionalProperties: false,
  properties: {
    schemas: { type: "array", items: schemaCatalogEntryShape, minItems: 1, maxItems: 500 },
    counts: {
      type: "object",
      additionalProperties: false,
      properties: {
        business: { type: "integer", minimum: 0 },
        api: { type: "integer", minimum: 0 },
        system: { type: "integer", minimum: 0 },
      },
      required: ["business", "api", "system"],
    },
    generatedAt: { type: "string", format: "date-time" },
  },
  required: ["schemas", "counts", "generatedAt"],
} as const;

export type Tile = FromSchema<typeof tileSchema>;
export type TileColor = NonNullable<Tile["color"]>;
export type Meld = FromSchema<typeof meldSchema>;
export type PublicPlayer = FromSchema<typeof publicPlayerSchema>;
export type GameEvent = FromSchema<typeof gameEventSchema>;
export type PublicGameState = FromSchema<typeof publicGameStateSchema>;
export type GameMode = PublicGameState["mode"];
export type GameStatus = PublicGameState["status"];
export type StoredPlayer = FromSchema<typeof storedPlayerSchema>;
export type StoredGame = FromSchema<typeof storedGameSchema>;
export type CreateGameInput = FromSchema<typeof createGameInputSchema>;
export type AssistId = FromSchema<typeof setAssistInputSchema>["assistId"];
export type AssistPolicy = PublicGameState["assistPolicy"][AssistId];
export type AssistPolicyMap = PublicGameState["assistPolicy"];
export type SetAssistInput = FromSchema<typeof setAssistInputSchema>;
export type JoinGameInput = FromSchema<typeof joinGameInputSchema>;
export type AddComputerInput = FromSchema<typeof addComputerInputSchema>;
export type ComputerStrategyId = AddComputerInput["strategy"];
export type StartGameInput = FromSchema<typeof startGameInputSchema>;
export type TurnAction = FromSchema<typeof turnActionSchema>;
export type TakeActionInput = FromSchema<typeof takeActionInputSchema>;
export type SaveTurnDraftInput = FromSchema<typeof saveTurnDraftInputSchema>;
export type GameSession = FromSchema<typeof gameSessionSchema>;
export type SessionCredentials = FromSchema<typeof sessionCredentialsSchema>;
export type OkResponse = FromSchema<typeof okResponseSchema>;
export type HealthResponse = FromSchema<typeof healthResponseSchema>;
export type ApiError = FromSchema<typeof apiErrorSchema>;
export type RoomResult = FromSchema<typeof roomResultSchema>;
export type ServerSocketMessage = FromSchema<typeof serverSocketMessageSchema>;
export type ClientSocketMessage = FromSchema<typeof clientSocketMessageSchema>;
export type HubDiscovery = FromSchema<typeof hubDiscoverySchema>;
export type DevProject = FromSchema<typeof devProjectSchema>;
export type RegistrationResponse = FromSchema<typeof registrationResponseSchema>;
export type UnregisterRequest = FromSchema<typeof unregisterRequestSchema>;
export type UnregisterResponse = FromSchema<typeof unregisterResponseSchema>;
export type SchemaDocument = FromSchema<typeof schemaDocumentSchema>;
export type SchemaCatalogEntry = FromSchema<typeof schemaCatalogEntrySchema>;
export type SchemaCatalogResponse = FromSchema<typeof schemaCatalogResponseSchema>;
