import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/server/game-room";
import type { Meld, StoredGame } from "../src/schemas";

const hostToken = "timeout-host-token";
const guestToken = "timeout-guest-token";
const initialBoard: Meld[] = [{
  id: "coral-run",
  tileIds: ["coral-5-1", "coral-6-1", "coral-7-1"],
}];
const hostRack = ["coral-8-1", "sun-1-1"];

type GameRoomStub = ReturnType<typeof env.GAME_ROOMS.getByName>;

async function createTimeoutRoom(): Promise<{
  room: GameRoomStub;
  turnStartedAt: number;
}> {
  const roomCode = `X${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
  const room = env.GAME_ROOMS.getByName(roomCode);
  expect(await room.create(
    roomCode,
    { name: "Ada", mode: "realtime", maxPlayers: 2 },
    "host",
    await hashToken(hostToken),
  )).toEqual({ ok: true });
  expect(await room.join("Grace", "guest", await hashToken(guestToken))).toEqual({ ok: true });
  expect(await room.start("host", hostToken)).toEqual({ ok: true });

  const turnStartedAt = Date.now();
  await runInDurableObject(room, (_instance, state) => {
    const row = state.storage.sql.exec<{ json: string }>(
      "SELECT json FROM game_state WHERE singleton = 1",
    ).one();
    const stored = JSON.parse(row.json) as StoredGame;
    const host = stored.players.find((player) => player.id === "host");
    const guest = stored.players.find((player) => player.id === "guest");
    if (!host || !guest) throw new Error("Expected both timeout test players.");

    const assigned = new Set([...initialBoard.flatMap((meld) => meld.tileIds), ...hostRack]);
    const remaining = Object.keys(stored.tiles).filter((tileId) => !assigned.has(tileId));
    host.rack = [...hostRack];
    host.opened = true;
    guest.rack = remaining.splice(0, 14);
    guest.opened = true;
    stored.pool = remaining;
    stored.board = structuredClone(initialBoard);
    stored.turnIndex = stored.players.indexOf(host);
    stored.turnStartedAt = turnStartedAt;
    stored.turnDeadline = turnStartedAt + 60_000;
    stored.turnDraft = null;
    stored.consecutiveEmptyDraws = 0;
    stored.status = "playing";
    stored.winnerId = null;
    stored.scores = null;
    stored.version += 1;
    stored.updatedAt = Date.now();
    state.storage.sql.exec(
      "UPDATE game_state SET json = ?, updated_at = ? WHERE singleton = 1",
      JSON.stringify(stored),
      stored.updatedAt,
    );
  });
  await evictDurableObject(room);
  return { room, turnStartedAt };
}

async function expireTurn(room: GameRoomStub): Promise<void> {
  await runInDurableObject(room, (_instance, state) => {
    const row = state.storage.sql.exec<{ json: string }>(
      "SELECT json FROM game_state WHERE singleton = 1",
    ).one();
    const stored = JSON.parse(row.json) as StoredGame;
    stored.turnDeadline = Date.now() - 1;
    state.storage.sql.exec(
      "UPDATE game_state SET json = ?, updated_at = ? WHERE singleton = 1",
      JSON.stringify(stored),
      stored.updatedAt,
    );
  });
  await evictDurableObject(room);
}

describe("turn timeout resolution", () => {
  it("draws a tile when the player made no play", async () => {
    const { room } = await createTimeoutRoom();
    const before = await room.getPublicState("host", hostToken);
    await expireTurn(room);

    expect(await runDurableObjectAlarm(room)).toBe(true);
    const after = await room.getPublicState("host", hostToken);

    expect(after.currentPlayerId).toBe("guest");
    expect(after.board).toEqual(initialBoard);
    expect(after.myRack).toHaveLength(before.myRack.length + 1);
    expect(after.poolCount).toBe(before.poolCount - 1);
    expect(after.history.at(-1)).toMatchObject({ kind: "timeout", playerId: "host" });
  });

  it("accepts a valid in-progress board as if the player submitted it", async () => {
    const { room, turnStartedAt } = await createTimeoutRoom();
    const proposedBoard: Meld[] = [{
      id: "extended-coral-run",
      tileIds: [...initialBoard[0]!.tileIds, "coral-8-1"],
    }];
    const before = await room.getPublicState("host", hostToken);
    expect(await room.saveTurnDraft("host", hostToken, {
      turnStartedAt,
      sequence: 1,
      board: proposedBoard,
    })).toEqual({ ok: true });
    const savedForPlayer = await room.getPublicState("host", hostToken);
    const visibleToOpponent = await room.getPublicState("guest", guestToken);
    expect(savedForPlayer.myTurnDraft).toEqual(proposedBoard);
    expect(savedForPlayer.turnDraft).toEqual(proposedBoard);
    expect(visibleToOpponent.myTurnDraft).toBeNull();
    expect(visibleToOpponent.turnDraft).toEqual(proposedBoard);
    await expireTurn(room);

    expect(await runDurableObjectAlarm(room)).toBe(true);
    const after = await room.getPublicState("host", hostToken);

    expect(after.currentPlayerId).toBe("guest");
    expect(after.board.map((meld) => meld.tileIds)).toEqual(proposedBoard.map((meld) => meld.tileIds));
    expect(after.myRack).toEqual(["sun-1-1"]);
    expect(after.myTurnDraft).toBeNull();
    expect(after.poolCount).toBe(before.poolCount);
    expect(after.history.at(-1)).toMatchObject({ kind: "played", playerId: "host" });
  });

  it("discards an invalid in-progress board and draws a tile", async () => {
    const { room, turnStartedAt } = await createTimeoutRoom();
    const invalidBoard: Meld[] = [
      ...initialBoard,
      { id: "incomplete-meld", tileIds: ["sun-1-1"] },
    ];
    const before = await room.getPublicState("host", hostToken);
    expect(await room.saveTurnDraft("host", hostToken, {
      turnStartedAt,
      sequence: 1,
      board: invalidBoard,
    })).toEqual({ ok: true });
    await expireTurn(room);

    expect(await runDurableObjectAlarm(room)).toBe(true);
    const after = await room.getPublicState("host", hostToken);

    expect(after.currentPlayerId).toBe("guest");
    expect(after.board).toEqual(initialBoard);
    expect(after.myRack).toHaveLength(before.myRack.length + 1);
    expect(after.myRack).toEqual(expect.arrayContaining(hostRack));
    expect(after.poolCount).toBe(before.poolCount - 1);
    expect(after.history.at(-1)).toMatchObject({ kind: "timeout", playerId: "host" });
  });

  it("does not let an older in-flight edit overwrite a later reset", async () => {
    const { room, turnStartedAt } = await createTimeoutRoom();
    const staleBoard: Meld[] = [
      ...initialBoard,
      { id: "stale-incomplete-meld", tileIds: ["sun-1-1"] },
    ];
    expect(await room.saveTurnDraft("host", hostToken, {
      turnStartedAt,
      sequence: 1,
      board: staleBoard,
    })).toEqual({ ok: true });
    expect(await room.saveTurnDraft("host", hostToken, {
      turnStartedAt,
      sequence: 2,
      board: initialBoard,
    })).toEqual({ ok: true });
    expect(await room.saveTurnDraft("host", hostToken, {
      turnStartedAt,
      sequence: 1,
      board: staleBoard,
    })).toEqual({ ok: true });
    await expireTurn(room);

    expect(await runDurableObjectAlarm(room)).toBe(true);
    const after = await room.getPublicState("host", hostToken);

    expect(after.board).toEqual(initialBoard);
    expect(after.myRack).toHaveLength(hostRack.length + 1);
    expect(after.history.at(-1)).toMatchObject({ kind: "timeout", playerId: "host" });
  });
});
