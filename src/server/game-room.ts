import { DurableObject } from "cloudflare:workers";
import { COMPUTER_STRATEGIES } from "../schemas";
import {
  ASSIST_IDS,
  ASSIST_POLICIES,
  DEFAULT_ASSIST_POLICY,
  enabledAssistsForPolicy,
} from "../shared/assists";
import {
  createTileSet,
  hasLegalMove,
  rackPenalty,
  turnDuration,
  validateTurn,
} from "../shared/rules";
import type {
  ComputerStrategyId,
  CreateGameInput,
  AssistId,
  AssistPolicy,
  AssistPolicyMap,
  GameEvent,
  PublicGameState,
  PublicPlayer,
  RoomResult,
  SaveTurnDraftInput,
  ServerSocketMessage,
  StoredGame,
  StoredPlayer,
  Tile,
  TurnAction,
} from "../schemas";
import { decodeSessionCookie } from "../shared/session-cookie";
import { describeValidationErrors, validators } from "../validation";
import { getComputerStrategy } from "./computer-strategies";

interface SocketAttachment {
  playerId: string;
}

const MAX_HISTORY = 40;
const COMPUTER_THINK_MS = 650;
const AUTO_DRAW_DELAY_MS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAssistPolicy(value: unknown): AssistPolicyMap {
  const candidate = isRecord(value) ? value : {};
  return Object.fromEntries(ASSIST_IDS.map((assistId) => {
    const policy = candidate[assistId];
    return [
      assistId,
      ASSIST_POLICIES.some((allowedPolicy) => allowedPolicy === policy)
        ? policy as AssistPolicy
        : DEFAULT_ASSIST_POLICY[assistId],
    ];
  })) as AssistPolicyMap;
}

function normalizeEnabledAssists(value: unknown, policy: AssistPolicyMap): AssistId[] {
  if (!Array.isArray(value)) return enabledAssistsForPolicy(policy);
  return ASSIST_IDS.filter(
    (assistId) => value.includes(assistId) && policy[assistId] !== "disallowed",
  );
}

function upgradeStoredGame(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.players)) return value;
  const assistPolicy = normalizeAssistPolicy(value.assistPolicy);
  return {
    ...value,
    assistPolicy,
    turnDraft: value.turnDraft ?? null,
    players: value.players.map((player) => {
      if (!isRecord(player)) return player;
      const isComputer = player.isComputer === true;
      const computerStrategy = isComputer
        && typeof player.computerStrategy === "string"
        && COMPUTER_STRATEGIES.some((strategy) => strategy === player.computerStrategy)
        ? player.computerStrategy
        : null;
      return {
        ...player,
        isComputer,
        computerStrategy,
        enabledAssists: normalizeEnabledAssists(player.enabledAssists, assistPolicy),
      };
    }),
  };
}

function event(
  kind: GameEvent["kind"],
  message: string,
  playerId: string | null = null,
): GameEvent {
  return { id: crypto.randomUUID(), at: Date.now(), playerId, kind, message };
}

function secureShuffle(values: string[]): string[] {
  const result = [...values];
  const random = new Uint32Array(Math.max(result.length, 1));
  crypto.getRandomValues(random);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = (random[index] ?? 0) % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tokenMatches(token: string, expectedHash: string): Promise<boolean> {
  const actualHash = await hashToken(token);
  return crypto.subtle.timingSafeEqual(hexToBytes(actualHash), hexToBytes(expectedHash));
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export class GameRoom extends DurableObject<Env> {
  private cache: StoredGame | null = null;
  private legalMoveCache = new Map<string, boolean>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS game_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    });
  }

  private load(): StoredGame | null {
    if (this.cache) return this.cache;
    const rows = this.ctx.storage.sql
      .exec<{ json: string }>("SELECT json FROM game_state WHERE singleton = 1")
      .toArray();
    const row = rows[0];
    if (!row) return null;
    const value = upgradeStoredGame(JSON.parse(row.json) as unknown);
    if (!validators.storedGame(value)) {
      throw new Error(`Invalid persisted game state: ${describeValidationErrors(validators.storedGame.errors)}`);
    }
    this.cache = value;
    return value;
  }

  private persist(state: StoredGame): void {
    if (!validators.storedGame(state)) {
      throw new Error(`Refusing to persist invalid game state: ${describeValidationErrors(validators.storedGame.errors)}`);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO game_state (singleton, json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      JSON.stringify(state),
      state.updatedAt,
    );
    this.cache = state;
    this.legalMoveCache.clear();
  }

  private async authenticated(token: string, player: StoredPlayer): Promise<boolean> {
    if (player.isComputer || !token || token.length > 256) return false;
    return tokenMatches(token, player.tokenHash);
  }

  private playerFor(state: StoredGame, playerId: string): StoredPlayer {
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("Player not found in this room.");
    return player;
  }

  private assistEnabled(state: StoredGame, player: StoredPlayer, assistId: AssistId): boolean {
    return state.assistPolicy[assistId] !== "disallowed" && player.enabledAssists.includes(assistId);
  }

  private playerHasLegalMove(state: StoredGame, player: StoredPlayer): boolean {
    const cacheKey = `${state.version}:${player.id}`;
    const cached = this.legalMoveCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = hasLegalMove({
      board: state.board,
      rack: player.rack,
      opened: player.opened,
      tiles: state.tiles,
    });
    this.legalMoveCache.set(cacheKey, result);
    return result;
  }

  private noMovePossible(state: StoredGame, player: StoredPlayer): boolean {
    if (state.status !== "playing" || state.players[state.turnIndex]?.id !== player.id) return false;
    if (
      !this.assistEnabled(state, player, "no-move-alert")
      && !this.assistEnabled(state, player, "auto-draw")
    ) return false;
    return !this.playerHasLegalMove(state, player);
  }

  private view(state: StoredGame, playerId: string): PublicGameState {
    const me = this.playerFor(state, playerId);
    const currentPlayer = state.status === "playing" ? state.players[state.turnIndex] : null;
    const myTurnDraft = state.turnDraft?.playerId === playerId
      && state.turnDraft.turnStartedAt === state.turnStartedAt
      ? state.turnDraft.board
      : null;
    const players: PublicPlayer[] = state.players.map((player) => ({
      id: player.id,
      name: player.name,
      rackCount: player.rack.length,
      rackTileIds: player.isComputer ? [...player.rack] : [],
      opened: player.opened,
      connected: player.isComputer || this.ctx.getWebSockets(`player:${player.id}`).length > 0,
      isHost: player.id === state.hostPlayerId,
      isComputer: player.isComputer,
      computerStrategy: player.computerStrategy,
    }));

    const view: PublicGameState = {
      id: state.id,
      version: state.version,
      mode: state.mode,
      status: state.status,
      maxPlayers: state.maxPlayers,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      turnStartedAt: state.turnStartedAt,
      turnDeadline: state.turnDeadline,
      currentPlayerId: currentPlayer?.id ?? null,
      winnerId: state.winnerId,
      poolCount: state.pool.length,
      board: state.board,
      players,
      myPlayerId: me.id,
      myRack: me.rack,
      myTurnDraft,
      tiles: state.tiles,
      history: state.history.slice(-12),
      scores: state.scores,
      assistPolicy: state.assistPolicy,
      enabledAssists: me.enabledAssists,
      noMovePossible: this.noMovePossible(state, me),
    };
    if (!validators.publicGameState(view)) {
      throw new Error(`Invalid public game state: ${describeValidationErrors(validators.publicGameState.errors)}`);
    }
    return view;
  }

  private sendSocket(socket: WebSocket, message: ServerSocketMessage): void {
    if (!validators.serverSocketMessage(message)) {
      throw new Error(`Invalid WebSocket response: ${describeValidationErrors(validators.serverSocketMessage.errors)}`);
    }
    socket.send(JSON.stringify(message));
  }

  private broadcast(state: StoredGame): void {
    const views = new Map<string, PublicGameState>();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() as SocketAttachment | null;
        if (!attachment) continue;
        let view = views.get(attachment.playerId);
        if (!view) {
          view = this.view(state, attachment.playerId);
          views.set(attachment.playerId, view);
        }
        this.sendSocket(socket, { type: "state", state: view });
      } catch (error) {
        console.error(JSON.stringify({ message: "websocket broadcast failed", error: publicError(error) }));
      }
    }
  }

  private addHistory(state: StoredGame, item: GameEvent): void {
    state.history.push(item);
    if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
  }

  private setNextTurn(state: StoredGame): void {
    state.turnDraft = null;
    state.turnIndex = (state.turnIndex + 1) % state.players.length;
    state.turnStartedAt = Date.now();
    state.turnDeadline = state.turnStartedAt + turnDuration(state.mode);
  }

  private calculateScores(state: StoredGame, winnerId: string): Record<string, number> {
    const scores: Record<string, number> = {};
    let winnerScore = 0;
    for (const player of state.players) {
      if (player.id === winnerId) continue;
      const penalty = rackPenalty(player.rack, state.tiles);
      scores[player.id] = -penalty;
      winnerScore += penalty;
    }
    scores[winnerId] = winnerScore;
    return scores;
  }

  private finishStalemate(state: StoredGame): void {
    const penalties = state.players.map((player) => ({
      player,
      penalty: rackPenalty(player.rack, state.tiles),
    }));
    penalties.sort((left, right) => left.penalty - right.penalty || left.player.joinedAt - right.player.joinedAt);
    const winner = penalties[0];
    if (!winner) return;

    const scores: Record<string, number> = {};
    let winnerScore = 0;
    for (const item of penalties) {
      const difference = item.penalty - winner.penalty;
      if (item.player.id === winner.player.id) winnerScore += difference;
      else scores[item.player.id] = -difference;
    }
    scores[winner.player.id] = winnerScore;
    state.status = "finished";
    state.winnerId = winner.player.id;
    state.scores = scores;
    state.turnDeadline = null;
    state.turnStartedAt = null;
    state.turnDraft = null;
    this.addHistory(state, event("won", `${winner.player.name} won the blocked game with the lowest rack.`, winner.player.id));
  }

  private drawAndAdvance(
    state: StoredGame,
    player: StoredPlayer,
    reason: "manual" | "timeout" | "automatic",
  ): void {
    const drawn = state.pool.pop();
    if (drawn) {
      player.rack.push(drawn);
      state.consecutiveEmptyDraws = 0;
    } else {
      state.consecutiveEmptyDraws += 1;
    }

    this.addHistory(
      state,
      event(
        reason === "timeout" ? "timeout" : "drew",
        reason === "timeout"
          ? `${player.name}'s clock ran out${drawn ? "; a tile was drawn." : "."}`
          : reason === "automatic"
            ? `${player.name} auto-drew${drawn ? " a tile because no move was possible" : " from an empty pool"}.`
          : `${player.name} drew${drawn ? " a tile" : " from an empty pool"}.`,
        player.id,
      ),
    );

    if (!drawn && state.consecutiveEmptyDraws >= state.players.length) {
      this.finishStalemate(state);
      return;
    }
    this.setNextTurn(state);
  }

  private async scheduleDeadline(state: StoredGame): Promise<void> {
    const currentPlayer = state.status === "playing" ? state.players[state.turnIndex] : null;
    if (currentPlayer?.isComputer) {
      await this.ctx.storage.setAlarm(Date.now() + COMPUTER_THINK_MS);
    } else if (
      currentPlayer
      && this.assistEnabled(state, currentPlayer, "auto-draw")
      && !this.playerHasLegalMove(state, currentPlayer)
    ) {
      await this.ctx.storage.setAlarm(Date.now() + AUTO_DRAW_DELAY_MS);
    } else if (state.status === "playing" && state.turnDeadline) {
      await this.ctx.storage.setAlarm(state.turnDeadline);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async create(
    roomCode: string,
    input: CreateGameInput,
    playerId: string,
    tokenHash: string,
  ): Promise<RoomResult> {
    if (this.load()) return { ok: false, error: "That room code is already in use." };
    const now = Date.now();
    const assistPolicy = normalizeAssistPolicy(input.assistPolicy);
    const state: StoredGame = {
      id: roomCode,
      version: 1,
      mode: input.mode,
      status: "lobby",
      maxPlayers: input.maxPlayers,
      hostPlayerId: playerId,
      createdAt: now,
      updatedAt: now,
      turnStartedAt: null,
      turnDeadline: null,
      turnIndex: 0,
      winnerId: null,
      players: [{
        id: playerId,
        name: input.name,
        tokenHash,
        rack: [],
        opened: false,
        joinedAt: now,
        isComputer: false,
        computerStrategy: null,
        enabledAssists: enabledAssistsForPolicy(assistPolicy),
      }],
      pool: [],
      board: [],
      tiles: createTileSet(),
      history: [event("created", `${input.name} opened the table.`, playerId)],
      scores: null,
      consecutiveEmptyDraws: 0,
      assistPolicy,
      turnDraft: null,
    };
    this.persist(state);
    return { ok: true };
  }

  async join(name: string, playerId: string, tokenHash: string): Promise<RoomResult> {
    const current = this.load();
    if (!current) return { ok: false, error: "Room not found." };
    const state = structuredClone(current);
    if (state.status !== "lobby") return { ok: false, error: "This game has already started." };
    if (state.players.length >= state.maxPlayers) return { ok: false, error: "This table is full." };
    if (state.players.some((player) => player.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return { ok: false, error: "Choose a different name for this table." };
    }

    state.players.push({
      id: playerId,
      name,
      tokenHash,
      rack: [],
      opened: false,
      joinedAt: Date.now(),
      isComputer: false,
      computerStrategy: null,
      enabledAssists: enabledAssistsForPolicy(state.assistPolicy),
    });
    state.version += 1;
    state.updatedAt = Date.now();
    this.addHistory(state, event("joined", `${name} pulled up a chair.`, playerId));
    this.persist(state);
    this.broadcast(state);
    return { ok: true };
  }

  async addComputer(playerId: string, token: string, strategy: ComputerStrategyId): Promise<RoomResult> {
    const beforeAuth = this.load();
    if (!beforeAuth) return { ok: false, error: "Room not found." };
    const authPlayer = this.playerFor(beforeAuth, playerId);
    if (!(await this.authenticated(token, authPlayer))) return { ok: false, error: "That player link is not valid." };
    const computerTokenHash = await hashToken(crypto.randomUUID());

    const current = this.load();
    if (!current) return { ok: false, error: "Room not found." };
    const state = structuredClone(current);
    if (state.hostPlayerId !== playerId) return { ok: false, error: "Only the host can add a computer player." };
    if (state.status !== "lobby") return { ok: false, error: "This game has already started." };
    if (state.players.length >= state.maxPlayers) return { ok: false, error: "This table is full." };

    const existingComputers = state.players.filter((player) => player.isComputer).length;
    const name = existingComputers === 0 ? "Guppy Bot" : `Guppy Bot ${existingComputers + 1}`;
    const computerId = `computer-${crypto.randomUUID()}`;
    state.players.push({
      id: computerId,
      name,
      tokenHash: computerTokenHash,
      rack: [],
      opened: false,
      joinedAt: Date.now(),
      isComputer: true,
      computerStrategy: strategy,
      enabledAssists: [],
    });
    state.version += 1;
    state.updatedAt = Date.now();
    this.addHistory(state, event("joined", `${name} joined with the ${strategy} strategy.`, computerId));
    this.persist(state);
    this.broadcast(state);
    return { ok: true };
  }

  async getPublicState(playerId: string, token: string): Promise<PublicGameState> {
    const state = this.load();
    if (!state) throw new Error("Room not found.");
    const player = this.playerFor(state, playerId);
    if (!(await this.authenticated(token, player))) throw new Error("That player link is not valid.");
    return this.view(this.load() ?? state, playerId);
  }

  async setAssist(
    playerId: string,
    token: string,
    assistId: AssistId,
    enabled: boolean,
  ): Promise<RoomResult> {
    const beforeAuth = this.load();
    if (!beforeAuth) return { ok: false, error: "Room not found." };
    const authPlayer = this.playerFor(beforeAuth, playerId);
    if (!(await this.authenticated(token, authPlayer))) return { ok: false, error: "That player link is not valid." };

    const current = this.load();
    if (!current) return { ok: false, error: "Room not found." };
    const state = structuredClone(current);
    const player = this.playerFor(state, playerId);
    if (state.assistPolicy[assistId] === "disallowed") {
      return { ok: false, error: "That assist is not allowed at this table." };
    }

    const enabledAssists = new Set(player.enabledAssists);
    if (enabled) enabledAssists.add(assistId);
    else enabledAssists.delete(assistId);
    const nextEnabledAssists = ASSIST_IDS.filter((candidate) => enabledAssists.has(candidate));
    if (
      nextEnabledAssists.length === player.enabledAssists.length
      && nextEnabledAssists.every((candidate, index) => candidate === player.enabledAssists[index])
    ) return { ok: true };

    player.enabledAssists = nextEnabledAssists;
    state.version += 1;
    state.updatedAt = Date.now();
    this.persist(state);
    this.broadcast(state);
    await this.scheduleDeadline(state);
    return { ok: true };
  }

  async start(playerId: string, token: string): Promise<RoomResult> {
    const beforeAuth = this.load();
    if (!beforeAuth) return { ok: false, error: "Room not found." };
    const authPlayer = this.playerFor(beforeAuth, playerId);
    if (!(await this.authenticated(token, authPlayer))) return { ok: false, error: "That player link is not valid." };

    const current = this.load();
    if (!current) return { ok: false, error: "Room not found." };
    const state = structuredClone(current);
    if (state.hostPlayerId !== playerId) return { ok: false, error: "Only the host can start the game." };
    if (state.status !== "lobby") return { ok: false, error: "This game has already started." };
    if (state.players.length < 2) return { ok: false, error: "Invite at least one more player." };

    state.players = secureShuffle(state.players.map((player) => player.id)).map(
      (id) => state.players.find((player) => player.id === id)!,
    );
    state.pool = secureShuffle(Object.keys(state.tiles));
    for (let round = 0; round < 14; round += 1) {
      for (const player of state.players) {
        const tileId = state.pool.pop();
        if (tileId) player.rack.push(tileId);
      }
    }
    state.status = "playing";
    state.turnIndex = 0;
    state.turnStartedAt = Date.now();
    state.turnDeadline = state.turnStartedAt + turnDuration(state.mode);
    state.version += 1;
    state.updatedAt = Date.now();
    this.addHistory(state, event("started", `${state.players[0]?.name ?? "The first player"} goes first.`));
    this.persist(state);
    this.broadcast(state);
    await this.scheduleDeadline(state);
    return { ok: true };
  }

  private applyTurnAction(state: StoredGame, currentPlayer: StoredPlayer, action: TurnAction): RoomResult {
    if (action.type === "draw") {
      this.drawAndAdvance(state, currentPlayer, "manual");
      return { ok: true };
    }

    const validation = validateTurn({
      previousBoard: state.board,
      proposedBoard: action.board,
      rack: currentPlayer.rack,
      opened: currentPlayer.opened,
      tiles: state.tiles,
    });
    if (!validation.valid) return { ok: false, error: validation.reason ?? "That turn is not legal." };

    const played = new Set(validation.playedTileIds);
    currentPlayer.rack = currentPlayer.rack.filter((tileId) => !played.has(tileId));
    currentPlayer.opened = true;
    state.board = action.board.map((meld, index) => ({
      id: `meld-${state.version + 1}-${index + 1}`,
      tileIds: [...meld.tileIds],
    }));
    state.consecutiveEmptyDraws = 0;
    this.addHistory(
      state,
      event(
        "played",
        `${currentPlayer.name} played ${validation.playedTileIds.length} tile${validation.playedTileIds.length === 1 ? "" : "s"}${validation.openingPoints ? ` and opened with ${validation.openingPoints}` : ""}.`,
        currentPlayer.id,
      ),
    );

    if (currentPlayer.rack.length === 0) {
      state.status = "finished";
      state.winnerId = currentPlayer.id;
      state.scores = this.calculateScores(state, currentPlayer.id);
      state.turnStartedAt = null;
      state.turnDeadline = null;
      state.turnDraft = null;
      this.addHistory(state, event("won", `${currentPlayer.name} went out and won!`, currentPlayer.id));
    } else {
      this.setNextTurn(state);
    }
    return { ok: true };
  }

  private applyComputerTurn(state: StoredGame, currentPlayer: StoredPlayer): void {
    const strategy = getComputerStrategy(currentPlayer.computerStrategy ?? "basic");
    let action: TurnAction = { type: "draw" };
    try {
      action = strategy.chooseTurn({
        version: state.version,
        board: state.board,
        rack: currentPlayer.rack,
        opened: currentPlayer.opened,
        tiles: state.tiles,
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: "computer strategy failed",
        playerId: currentPlayer.id,
        strategy: strategy.id,
        error: publicError(error),
      }));
    }

    const result = this.applyTurnAction(state, currentPlayer, action);
    if (!result.ok && action.type !== "draw") {
      console.error(JSON.stringify({
        message: "computer strategy returned an illegal move",
        playerId: currentPlayer.id,
        strategy: strategy.id,
        error: result.error,
      }));
      this.applyTurnAction(state, currentPlayer, { type: "draw" });
    }
  }

  private async finalizeTurn(state: StoredGame): Promise<void> {
    state.version += 1;
    state.updatedAt = Date.now();
    this.persist(state);
    this.broadcast(state);
    await this.scheduleDeadline(state);
  }

  async act(playerId: string, token: string, action: TurnAction): Promise<RoomResult> {
    const beforeAuth = this.load();
    if (!beforeAuth) return { ok: false, error: "Room not found." };
    const authPlayer = this.playerFor(beforeAuth, playerId);
    if (!(await this.authenticated(token, authPlayer))) return { ok: false, error: "That player link is not valid." };

    const current = this.load();
    if (!current) return { ok: false, error: "Room not found." };
    const state = structuredClone(current);
    if (state.status !== "playing") return { ok: false, error: "The game is not in progress." };
    const currentPlayer = state.players[state.turnIndex];
    if (!currentPlayer || currentPlayer.id !== playerId) return { ok: false, error: "It is not your turn." };
    if (currentPlayer.isComputer) return { ok: false, error: "Computer turns are controlled by their strategy." };

    const result = this.applyTurnAction(state, currentPlayer, action);
    if (!result.ok) return result;
    await this.finalizeTurn(state);
    return { ok: true };
  }

  async saveTurnDraft(
    playerId: string,
    token: string,
    input: SaveTurnDraftInput,
  ): Promise<RoomResult> {
    const beforeAuth = this.load();
    if (!beforeAuth) return { ok: false, error: "Room not found." };
    const authPlayer = this.playerFor(beforeAuth, playerId);
    if (!(await this.authenticated(token, authPlayer))) return { ok: false, error: "That player link is not valid." };

    const current = this.load();
    if (!current) return { ok: false, error: "Room not found." };
    const state = structuredClone(current);
    if (state.status !== "playing") return { ok: false, error: "The game is not in progress." };
    const currentPlayer = state.players[state.turnIndex];
    if (!currentPlayer || currentPlayer.id !== playerId) return { ok: false, error: "It is not your turn." };
    if (currentPlayer.isComputer) return { ok: false, error: "Computer turns are controlled by their strategy." };
    if (state.turnStartedAt !== input.turnStartedAt) return { ok: false, error: "That turn has already ended." };
    if (state.turnDeadline === null || state.turnDeadline <= Date.now()) {
      return { ok: false, error: "The turn clock has already expired." };
    }

    const existingDraft = state.turnDraft;
    if (
      existingDraft
      && existingDraft.playerId === playerId
      && existingDraft.turnStartedAt === input.turnStartedAt
      && existingDraft.sequence >= input.sequence
    ) return { ok: true };

    state.turnDraft = {
      playerId,
      turnStartedAt: input.turnStartedAt,
      sequence: input.sequence,
      board: input.board.map((meld) => ({ ...meld, tileIds: [...meld.tileIds] })),
    };
    this.persist(state);
    return { ok: true };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLocaleLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }

    const state = this.load();
    if (!state) return new Response("Room not found.", { status: 404 });
    const cookieValue = decodeSessionCookie(request.headers.get("Cookie") ?? "", state.id);
    const cookieSession = validators.sessionCredentials(cookieValue) && cookieValue.roomCode === state.id
      ? cookieValue
      : undefined;
    const playerId = cookieSession?.playerId ?? "";
    const token = cookieSession?.token ?? "";
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (!player || !(await this.authenticated(token, player))) {
      return new Response("That player link is not valid.", { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [`player:${playerId}`]);
    server.serializeAttachment({ playerId } satisfies SocketAttachment);
    this.sendSocket(server, { type: "state", state: this.view(this.load() ?? state, playerId) });
    this.broadcast(this.load() ?? state);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 1_000) {
      this.sendSocket(socket, { type: "error", error: "Unsupported message." });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(message);
      if (!validators.clientSocketMessage(parsed)) {
        this.sendSocket(socket, { type: "error", error: "Unsupported message." });
        return;
      }
      this.sendSocket(socket, { type: "pong", at: Date.now() });
    } catch {
      this.sendSocket(socket, { type: "error", error: "Invalid message." });
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason);
    const state = this.load();
    if (state) this.broadcast(state);
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({ message: "room websocket error", error: publicError(error) }));
    socket.close(1011, "Connection error");
  }

  async alarm(): Promise<void> {
    const current = this.load();
    if (!current || current.status !== "playing" || !current.turnDeadline) return;
    const currentPlayer = current.players[current.turnIndex];
    if (!currentPlayer) return;

    if (currentPlayer.isComputer) {
      const state = structuredClone(current);
      const computer = state.players[state.turnIndex];
      if (!computer?.isComputer) return;
      this.applyComputerTurn(state, computer);
      await this.finalizeTurn(state);
      return;
    }

    if (
      this.assistEnabled(current, currentPlayer, "auto-draw")
      && !this.playerHasLegalMove(current, currentPlayer)
    ) {
      const state = structuredClone(current);
      const autoDrawPlayer = state.players[state.turnIndex];
      if (!autoDrawPlayer) return;
      this.drawAndAdvance(state, autoDrawPlayer, "automatic");
      await this.finalizeTurn(state);
      return;
    }

    if (current.turnDeadline > Date.now()) {
      await this.ctx.storage.setAlarm(current.turnDeadline);
      return;
    }

    const state = structuredClone(current);
    const timedOutPlayer = state.players[state.turnIndex];
    if (!timedOutPlayer) return;
    const draft = state.turnDraft;
    const hasCurrentDraft = draft
      && draft.playerId === timedOutPlayer.id
      && draft.turnStartedAt === state.turnStartedAt;
    const submittedDraft = hasCurrentDraft
      ? this.applyTurnAction(state, timedOutPlayer, { type: "commit", board: draft.board })
      : null;
    if (!submittedDraft?.ok) {
      state.turnDraft = null;
      this.drawAndAdvance(state, timedOutPlayer, "timeout");
    }
    await this.finalizeTurn(state);
  }
}

export { hashToken };
