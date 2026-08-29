import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chooseStartingPlayerIndex, hashToken } from "../src/server/game-room";
import { createTileSet } from "../src/shared/rules";
import type { StoredGame } from "../src/schemas";

describe("GameRoom", () => {
  it("sets tied starting-player draws aside until the tie is resolved", () => {
    const pool = ["coral-2-1", "sun-9-1", "ocean-7-1", "ink-7-1"];

    expect(chooseStartingPlayerIndex(2, pool, createTileSet())).toBe(0);
    expect(pool).toHaveLength(4);
    expect(new Set(pool)).toEqual(new Set([
      "coral-2-1",
      "sun-9-1",
      "ocean-7-1",
      "ink-7-1",
    ]));
  });

  it("creates, fills, starts, and advances a two-player game", async () => {
    const roomCode = `T${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
    const hostToken = "host-test-token";
    const guestToken = "guest-test-token";
    const room = env.GAME_ROOMS.getByName(roomCode);

    expect(await room.create(
      roomCode,
      { name: "Ada", mode: "realtime", maxPlayers: 2 },
      "host",
      await hashToken(hostToken),
    )).toEqual({ ok: true });
    expect(await room.join("Grace", "guest", await hashToken(guestToken))).toEqual({ ok: true });
    expect(await room.start("host", hostToken)).toEqual({ ok: true });

    const hostView = await room.getPublicState("host", hostToken);
    const guestView = await room.getPublicState("guest", guestToken);
    expect(hostView.status).toBe("playing");
    expect(hostView.players).toHaveLength(2);
    expect(hostView.myRack).toHaveLength(14);
    expect(guestView.myRack).toHaveLength(14);
    expect(hostView.players.every((player) => player.rackTileIds.length === 0)).toBe(true);
    expect(guestView.players.every((player) => player.rackTileIds.length === 0)).toBe(true);
    expect(hostView.poolCount).toBe(78);

    const currentId = hostView.currentPlayerId!;
    const currentToken = currentId === "host" ? hostToken : guestToken;
    expect(await room.act(currentId, currentToken, { type: "commit", board: hostView.board })).toEqual({
      ok: false,
      error: "Play at least one tile, or draw to end your turn.",
    });
    const afterRejectedCommit = await room.getPublicState(currentId, currentToken);
    expect(afterRejectedCommit.currentPlayerId).toBe(currentId);
    expect(afterRejectedCommit.version).toBe(hostView.version);
    expect(afterRejectedCommit.myRack).toHaveLength(14);

    expect(await room.act(currentId, currentToken, { type: "draw" })).toEqual({ ok: true });

    const nextView = await room.getPublicState("host", hostToken);
    expect(nextView.currentPlayerId).not.toBe(currentId);
    expect(nextView.poolCount).toBe(77);
    const drawer = nextView.players.find((player) => player.id === currentId);
    expect(drawer?.rackCount).toBe(15);
  });

  it("passes and finishes the game after everyone draws from an empty pool", async () => {
    const roomCode = `E${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
    const hostToken = "empty-pool-host-token";
    const guestToken = "empty-pool-guest-token";
    const room = env.GAME_ROOMS.getByName(roomCode);

    expect(await room.create(
      roomCode,
      { name: "Ada", mode: "realtime", maxPlayers: 2 },
      "host",
      await hashToken(hostToken),
    )).toEqual({ ok: true });
    expect(await room.join("Grace", "guest", await hashToken(guestToken))).toEqual({ ok: true });
    expect(await room.start("host", hostToken)).toEqual({ ok: true });

    await runInDurableObject(room, (_instance, state) => {
      const row = state.storage.sql.exec<{ json: string }>(
        "SELECT json FROM game_state WHERE singleton = 1",
      ).one();
      const stored = JSON.parse(row.json) as StoredGame;
      const host = stored.players.find((player) => player.id === "host");
      const guest = stored.players.find((player) => player.id === "guest");
      if (!host || !guest) throw new Error("Expected both empty-pool test players.");

      host.rack = ["coral-1-1"];
      guest.rack = ["coral-2-1"];
      stored.pool = [];
      stored.board = [];
      stored.turnIndex = stored.players.indexOf(host);
      stored.status = "playing";
      stored.turnStartedAt = Date.now();
      stored.turnDeadline = stored.turnStartedAt + 60_000;
      stored.turnDraft = null;
      stored.consecutiveEmptyDraws = 0;
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

    expect(await room.act("host", hostToken, { type: "draw" })).toEqual({ ok: true });
    const afterHostPass = await room.getPublicState("host", hostToken);
    expect(afterHostPass.status).toBe("playing");
    expect(afterHostPass.currentPlayerId).toBe("guest");
    expect(afterHostPass.history.at(-1)?.message).toBe("Ada passed because the pool is empty.");

    expect(await room.act("guest", guestToken, { type: "draw" })).toEqual({ ok: true });
    const finished = await room.getPublicState("host", hostToken);
    expect(finished.status).toBe("finished");
    expect(finished.winnerId).toBe("host");
    expect(finished.history.at(-1)?.message).toBe("Ada won the blocked game with the lowest rack.");
  });

  it("upgrades persisted wilcard tiles from the former representation", async () => {
    const legacyWilcardFlag = ["j", "oker"].join("");
    const legacyWilcardPrefix = `${legacyWilcardFlag}-`;
    const priorWilcardFlag = ["wild", "card"].join("");
    const priorWilcardPrefix = `${priorWilcardFlag}-`;
    const roomCode = `W${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
    const hostToken = "host-wilcard-upgrade-token";
    const guestToken = "guest-wilcard-upgrade-token";
    const room = env.GAME_ROOMS.getByName(roomCode);

    expect(await room.create(
      roomCode,
      { name: "Ada", mode: "realtime", maxPlayers: 2 },
      "host",
      await hashToken(hostToken),
    )).toEqual({ ok: true });
    expect(await room.join("Grace", "guest", await hashToken(guestToken))).toEqual({ ok: true });

    await runInDurableObject(room, (_instance, state) => {
      const row = state.storage.sql.exec<{ json: string }>(
        "SELECT json FROM game_state WHERE singleton = 1",
      ).one();
      const stored = JSON.parse(row.json) as Record<string, unknown>;
      const tiles = stored.tiles as Record<string, { id: string; wilcard: boolean; [key: string]: unknown }>;
      stored.tiles = Object.fromEntries(Object.entries(tiles).map(([id, tile]) => {
        const legacyId = id.replace(/^wilcard-/, id.endsWith("-1") ? legacyWilcardPrefix : priorWilcardPrefix);
        const { wilcard, ...legacyTile } = tile;
        const legacyFlag = id.endsWith("-1") ? legacyWilcardFlag : priorWilcardFlag;
        return [legacyId, { ...legacyTile, id: legacyId, [legacyFlag]: wilcard }];
      }));
      stored.pool = (stored.pool as string[]).map((id) => id.replace(
        /^wilcard-/,
        id.endsWith("-1") ? legacyWilcardPrefix : priorWilcardPrefix,
      ));
      state.storage.sql.exec(
        "UPDATE game_state SET json = ?, updated_at = ? WHERE singleton = 1",
        JSON.stringify(stored),
        Date.now(),
      );
    });
    await evictDurableObject(room);

    expect(await room.start("host", hostToken)).toEqual({ ok: true });
    const view = await room.getPublicState("host", hostToken);
    expect(view.tiles["wilcard-1"]).toEqual({
      id: "wilcard-1", color: null, value: null, wilcard: true,
    });
    expect(view.tiles["wilcard-2"]).toEqual({
      id: "wilcard-2", color: null, value: null, wilcard: true,
    });
    expect(view.tiles).not.toHaveProperty(`${legacyWilcardPrefix}1`);
  });

  it("rejects a qualifying opening that extends a table set", async () => {
    const roomCode = `O${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
    const hostToken = "host-opening-extension-token";
    const guestToken = "guest-opening-extension-token";
    const room = env.GAME_ROOMS.getByName(roomCode);

    expect(await room.create(
      roomCode,
      { name: "Ada", mode: "realtime", maxPlayers: 2 },
      "host",
      await hashToken(hostToken),
    )).toEqual({ ok: true });
    expect(await room.join("Grace", "guest", await hashToken(guestToken))).toEqual({ ok: true });
    expect(await room.start("host", hostToken)).toEqual({ ok: true });

    const previousBoard = [
      { id: "old-run-1", tileIds: ["ink-8-1", "ink-9-1", "ink-10-2", "ink-11-1"] },
      { id: "old-run-2", tileIds: ["ink-4-1", "ink-5-2", "ink-6-2"] },
    ];
    const playedTileIds = [
      "ink-12-1",
      "coral-5-2", "sun-5-1", "ocean-5-1",
      "coral-13-1", "ocean-13-2", "ink-13-2",
    ];
    const proposedBoard = [
      { id: "extended-run", tileIds: ["ink-8-1", "ink-9-1", "ink-10-2", "ink-11-1", "ink-12-1"] },
      previousBoard[1]!,
      { id: "opening-fives", tileIds: ["coral-5-2", "sun-5-1", "ocean-5-1"] },
      { id: "opening-thirteens", tileIds: ["coral-13-1", "ocean-13-2", "ink-13-2"] },
    ];

    await runInDurableObject(room, (_instance, state) => {
      const row = state.storage.sql.exec<{ json: string }>(
        "SELECT json FROM game_state WHERE singleton = 1",
      ).one();
      const stored = JSON.parse(row.json) as StoredGame;
      const host = stored.players.find((player) => player.id === "host");
      const guest = stored.players.find((player) => player.id === "guest");
      if (!host || !guest) throw new Error("Seeded players are missing.");

      const hostRack = [...playedTileIds, "sun-1-1"];
      const assigned = new Set([
        ...previousBoard.flatMap((set) => set.tileIds),
        ...hostRack,
      ]);
      const remainingTileIds = Object.keys(stored.tiles).filter((tileId) => !assigned.has(tileId));
      host.rack = hostRack;
      host.opened = false;
      guest.rack = remainingTileIds.slice(0, 14);
      stored.pool = remainingTileIds.slice(14);
      stored.board = previousBoard;
      stored.turnIndex = stored.players.indexOf(host);
      stored.status = "playing";
      stored.winnerId = null;
      stored.scores = null;
      stored.turnStartedAt = Date.now();
      stored.turnDeadline = stored.turnStartedAt + 120_000;
      stored.version += 1;
      stored.updatedAt = Date.now();
      state.storage.sql.exec(
        "UPDATE game_state SET json = ?, updated_at = ? WHERE singleton = 1",
        JSON.stringify(stored),
        stored.updatedAt,
      );
    });
    await evictDurableObject(room);

    const before = await room.getPublicState("host", hostToken);
    expect(before.board).toEqual(previousBoard);
    expect(before.myRack).toEqual([...playedTileIds, "sun-1-1"]);
    expect(before.players.find((player) => player.id === "host")?.opened).toBe(false);

    expect(await room.act("host", hostToken, { type: "commit", board: proposedBoard })).toEqual({
      ok: false,
      error: "Your opening turn can only use tiles from your rack; existing sets must stay unchanged.",
    });

    const after = await room.getPublicState("host", hostToken);
    expect(after.version).toBe(before.version);
    expect(after.currentPlayerId).toBe("host");
    expect(after.myRack).toEqual([...playedTileIds, "sun-1-1"]);
    expect(after.players.find((player) => player.id === "host")?.opened).toBe(false);
    expect(after.board).toEqual(previousBoard);
  });

  it("enforces the four-player maximum", async () => {
    const roomCode = `F${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
    const room = env.GAME_ROOMS.getByName(roomCode);
    expect(await room.create(roomCode, { name: "One", mode: "correspondence", maxPlayers: 4 }, "p1", await hashToken("t1"))).toEqual({ ok: true });
    for (let number = 2; number <= 4; number += 1) {
      expect(await room.join(`Player ${number}`, `p${number}`, await hashToken(`t${number}`))).toEqual({ ok: true });
    }
    expect(await room.join("Player 5", "p5", await hashToken("t5"))).toMatchObject({ ok: false, error: "This table is full." });
  });

  it("adds a configured computer and executes its turn through the room alarm", async () => {
    const roomCode = `B${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
    const hostToken = "host-computer-test-token";
    const room = env.GAME_ROOMS.getByName(roomCode);

    expect(await room.create(
      roomCode,
      { name: "Ada", mode: "realtime", maxPlayers: 2 },
      "host",
      await hashToken(hostToken),
    )).toEqual({ ok: true });
    expect(await room.addComputer("host", hostToken, "basic")).toEqual({ ok: true });

    const lobby = await room.getPublicState("host", hostToken);
    expect(lobby.players).toContainEqual(expect.objectContaining({
      name: "Guppy Bot",
      isComputer: true,
      computerStrategy: "basic",
      connected: true,
    }));
    expect(await room.start("host", hostToken)).toEqual({ ok: true });

    let playing = await room.getPublicState("host", hostToken);
    if (playing.currentPlayerId === "host") {
      expect(await room.act("host", hostToken, { type: "draw" })).toEqual({ ok: true });
      playing = await room.getPublicState("host", hostToken);
    }
    const computer = playing.players.find((player) => player.isComputer);
    expect(playing.currentPlayerId).toBe(computer?.id);
    expect(computer?.rackTileIds).toHaveLength(14);
    expect(playing.players.find((player) => !player.isComputer)?.rackTileIds).toEqual([]);

    const beforeComputerVersion = playing.version;
    expect(await runDurableObjectAlarm(room)).toBe(true);
    const afterComputer = await room.getPublicState("host", hostToken);
    expect(afterComputer.version).toBe(beforeComputerVersion + 1);
    expect(afterComputer.currentPlayerId).toBe("host");
    expect(afterComputer.history.at(-1)?.playerId).toBe(computer?.id);
  });

  it("applies table policy defaults and rejects disallowed assists", async () => {
    const roomCode = `A${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
    const hostToken = "host-assist-policy-token";
    const room = env.GAME_ROOMS.getByName(roomCode);

    expect(await room.create(
      roomCode,
      {
        name: "Ada",
        mode: "realtime",
        maxPlayers: 2,
        assistPolicy: {
          "no-move-alert": "default-off",
          "auto-draw": "disallowed",
          "rack-set-highlights": "default-off",
        },
      },
      "host",
      await hashToken(hostToken),
    )).toEqual({ ok: true });

    const initial = await room.getPublicState("host", hostToken);
    expect(initial.assistPolicy).toEqual({
      "no-move-alert": "default-off",
      "auto-draw": "disallowed",
      "rack-set-highlights": "default-off",
    });
    expect(initial.enabledAssists).toEqual([]);
    expect(await room.setAssist("host", hostToken, "no-move-alert", true)).toEqual({ ok: true });
    expect((await room.getPublicState("host", hostToken)).enabledAssists).toEqual(["no-move-alert"]);
    expect(await room.setAssist("host", hostToken, "auto-draw", true)).toEqual({
      ok: false,
      error: "That assist is not allowed at this table.",
    });
  });

  it("auto-draws from server state when the current player has no legal move", async () => {
    const roomCode = `D${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
    const hostToken = "host-auto-draw-token";
    const guestToken = "guest-auto-draw-token";
    const tokenByPlayer = { host: hostToken, guest: guestToken } as const;
    const room = env.GAME_ROOMS.getByName(roomCode);

    expect(await room.create(
      roomCode,
      {
        name: "Ada",
        mode: "realtime",
        maxPlayers: 2,
        assistPolicy: {
          "no-move-alert": "disallowed",
          "auto-draw": "default-off",
          "rack-set-highlights": "disallowed",
        },
      },
      "host",
      await hashToken(hostToken),
    )).toEqual({ ok: true });
    expect(await room.join("Grace", "guest", await hashToken(guestToken))).toEqual({ ok: true });
    expect(await room.start("host", hostToken)).toEqual({ ok: true });

    const started = await room.getPublicState("host", hostToken);
    const currentPlayerId = started.currentPlayerId as keyof typeof tokenByPlayer;
    await runInDurableObject(room, (_instance, state) => {
      const row = state.storage.sql.exec<{ json: string }>(
        "SELECT json FROM game_state WHERE singleton = 1",
      ).one();
      const stored = JSON.parse(row.json) as StoredGame;
      const currentPlayer = stored.players[stored.turnIndex];
      if (!currentPlayer) throw new Error("Current player missing from stored test game.");
      currentPlayer.rack = ["coral-1-1", "sun-2-1"];
      currentPlayer.opened = false;
      stored.version += 1;
      stored.updatedAt = Date.now();
      state.storage.sql.exec(
        "UPDATE game_state SET json = ?, updated_at = ? WHERE singleton = 1",
        JSON.stringify(stored),
        stored.updatedAt,
      );
    });
    await evictDurableObject(room);

    expect(await room.setAssist(currentPlayerId, tokenByPlayer[currentPlayerId], "auto-draw", true)).toEqual({ ok: true });
    const beforeAlarm = await room.getPublicState(currentPlayerId, tokenByPlayer[currentPlayerId]);
    expect(beforeAlarm.noMovePossible).toBe(true);
    expect(beforeAlarm.enabledAssists).toEqual(["auto-draw"]);

    expect(await runDurableObjectAlarm(room)).toBe(true);
    const afterAlarm = await room.getPublicState(currentPlayerId, tokenByPlayer[currentPlayerId]);
    expect(afterAlarm.currentPlayerId).not.toBe(currentPlayerId);
    expect(afterAlarm.history.at(-1)?.message).toContain("auto-drew a tile because no move was possible");
  });
});
