import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/server/game-room";
import type { GameSet, StoredGame } from "../src/schemas";

type GameRoomStub = ReturnType<typeof env.GAME_ROOMS.getByName>;

interface PlayingStateScenario {
  name: string;
  board: GameSet[];
  rack: string[];
  opened: boolean;
  shouldAutoDraw: boolean;
  repeatedChecks?: number;
}

const hostToken = "host-auto-draw-state-token";
const guestToken = "guest-auto-draw-state-token";

const set = (id: string, tileIds: string[]): GameSet => ({ id, tileIds });

function denseBlockedBoard(): GameSet[] {
  const board: GameSet[] = [];
  for (const color of ["coral", "sun", "ocean", "ink"] as const) {
    for (const copy of [1, 2] as const) {
      board.push(set(
        `${color}-${copy}-long-run`,
        Array.from({ length: 11 }, (_, index) => `${color}-${index + 3}-${copy}`),
      ));
    }
  }
  return board;
}

const scenarios: PlayingStateScenario[] = [
  {
    name: "auto-draws an unopened player whose only set is below 30 points",
    board: [],
    rack: ["coral-9-1", "sun-9-1", "ocean-9-1", "ink-2-1"],
    opened: false,
    shouldAutoDraw: true,
  },
  {
    name: "does not auto-draw an unopened player with an exact 30-point group",
    board: [],
    rack: ["coral-10-1", "sun-10-1", "ocean-10-1", "ink-2-1"],
    opened: false,
    shouldAutoDraw: false,
  },
  {
    name: "does not auto-draw when two disjoint opening sets total 30 points",
    board: [],
    rack: [
      "coral-5-1", "sun-5-1", "ocean-5-1",
      "coral-5-2", "sun-5-2", "ink-5-1",
      "ocean-1-1",
    ],
    opened: false,
    shouldAutoDraw: false,
  },
  {
    name: "auto-draws an unopened player who could only extend the table",
    board: [set("table-group", ["coral-5-1", "sun-5-1", "ocean-5-1"])],
    rack: ["ink-5-1", "coral-1-1"],
    opened: false,
    shouldAutoDraw: true,
  },
  {
    name: "does not auto-draw an opened player with a low-value rack-only set",
    board: [],
    rack: ["coral-1-1", "sun-1-1", "ocean-1-1", "ink-8-1"],
    opened: true,
    shouldAutoDraw: false,
  },
  {
    name: "does not auto-draw an opened player who can extend an existing group",
    board: [set("table-group", ["coral-5-1", "sun-5-1", "ocean-5-1"])],
    rack: ["ink-5-1", "coral-1-1"],
    opened: true,
    shouldAutoDraw: false,
  },
  {
    name: "does not auto-draw when the only move requires rearranging table sets",
    board: [
      set("coral-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1", "coral-9-1"]),
      set("sun-run", ["sun-5-1", "sun-6-1", "sun-7-1", "sun-8-1", "sun-9-1"]),
    ],
    rack: ["ocean-9-1"],
    opened: true,
    shouldAutoDraw: false,
  },
  {
    name: "does not auto-draw when a table wilcard can be replaced and replayed",
    board: [set("wilcard-run", ["ocean-7-1", "wilcard-1", "ocean-9-1"])],
    rack: ["ocean-8-1", "coral-5-1", "sun-5-1"],
    opened: true,
    shouldAutoDraw: false,
  },
  {
    name: "auto-draws an opened player whose tiles cannot join the table",
    board: [set("table-group", ["coral-5-1", "sun-5-1", "ocean-5-1"])],
    rack: ["coral-1-1", "sun-2-1"],
    opened: true,
    shouldAutoDraw: true,
  },
  {
    name: "auto-draws when a rack tile can form a set only by leaving invalid table leftovers",
    board: [
      set("fives", ["coral-5-1", "sun-5-1", "ocean-5-1"]),
      set("sun-run", ["sun-6-1", "sun-7-1", "sun-8-1"]),
    ],
    rack: ["sun-4-1"],
    opened: true,
    shouldAutoDraw: true,
  },
  {
    name: "auto-draws deterministically on a dense but provably blocked table",
    board: denseBlockedBoard(),
    rack: ["coral-1-1"],
    opened: true,
    shouldAutoDraw: true,
    repeatedChecks: 3,
  },
];

async function createStartedRoom(): Promise<GameRoomStub> {
  const roomCode = `S${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`.toLocaleUpperCase();
  const room = env.GAME_ROOMS.getByName(roomCode);
  expect(await room.create(
    roomCode,
    { name: "Ada", mode: "realtime", maxPlayers: 2 },
    "host",
    await hashToken(hostToken),
  )).toEqual({ ok: true });
  expect(await room.join("Grace", "guest", await hashToken(guestToken))).toEqual({ ok: true });
  expect(await room.start("host", hostToken)).toEqual({ ok: true });
  return room;
}

async function replaceWithScenario(
  room: GameRoomStub,
  scenario: PlayingStateScenario,
  hostAutoDraw = false,
): Promise<void> {
  await runInDurableObject(room, (_instance, state) => {
    const row = state.storage.sql.exec<{ json: string }>(
      "SELECT json FROM game_state WHERE singleton = 1",
    ).one();
    const stored = JSON.parse(row.json) as StoredGame;
    const hostIndex = stored.players.findIndex((player) => player.id === "host");
    const host = stored.players[hostIndex];
    const guest = stored.players.find((player) => player.id === "guest");
    if (hostIndex < 0 || !host || !guest) throw new Error("Expected both test players in stored game.");

    stored.status = "playing";
    stored.turnIndex = hostIndex;
    stored.turnStartedAt = Date.now();
    stored.turnDeadline = stored.turnStartedAt + 60_000;
    stored.board = scenario.board.map((item) => ({ ...item, tileIds: [...item.tileIds] }));
    stored.assistPolicy = {
      "no-move-alert": "default-on",
      "auto-draw": "default-off",
      "rack-set-highlights": "disallowed",
    };
    host.rack = [...scenario.rack];
    host.opened = scenario.opened;
    host.enabledAssists = hostAutoDraw ? ["no-move-alert", "auto-draw"] : ["no-move-alert"];
    guest.opened = true;
    guest.enabledAssists = ["no-move-alert"];

    const occupied = new Set([...stored.board.flatMap((item) => item.tileIds), ...host.rack]);
    const remaining = Object.keys(stored.tiles).filter((tileId) => !occupied.has(tileId));
    const guestRackSize = Math.min(14, Math.max(0, remaining.length - 1));
    guest.rack = remaining.splice(0, guestRackSize);
    stored.pool = remaining;
    stored.version += 1;
    stored.updatedAt = Date.now();
    stored.consecutiveEmptyDraws = 0;
    stored.winnerId = null;
    stored.scores = null;

    state.storage.sql.exec(
      "UPDATE game_state SET json = ?, updated_at = ? WHERE singleton = 1",
      JSON.stringify(stored),
      stored.updatedAt,
    );
  });
  await evictDurableObject(room);
}

async function alarmAt(room: GameRoomStub): Promise<number | null> {
  return runInDurableObject(room, (_instance, state) => state.storage.getAlarm());
}

describe("server auto-draw decisions from complete game states", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const room = await createStartedRoom();
      await replaceWithScenario(room, scenario, true);

      for (let check = 0; check < (scenario.repeatedChecks ?? 0); check += 1) {
        const repeatedView = await room.getPublicState("host", hostToken);
        expect(repeatedView.currentPlayerId).toBe("host");
        expect(repeatedView.enabledAssists).toEqual(["no-move-alert", "auto-draw"]);
        expect(repeatedView.noMovePossible).toBe(scenario.shouldAutoDraw);
        if (check + 1 < (scenario.repeatedChecks ?? 0)) await evictDurableObject(room);
      }

      const before = await room.getPublicState("host", hostToken);
      expect(before.currentPlayerId).toBe("host");
      expect(before.enabledAssists).toEqual(["no-move-alert", "auto-draw"]);
      expect(before.noMovePossible).toBe(scenario.shouldAutoDraw);

      expect(await alarmAt(room)).not.toBeNull();

      expect(await runDurableObjectAlarm(room)).toBe(true);
      const after = await room.getPublicState("host", hostToken);
      if (scenario.shouldAutoDraw) {
        expect(after.currentPlayerId).toBe("guest");
        expect(after.version).toBe(before.version + 1);
        expect(after.myRack).toHaveLength(before.myRack.length + 1);
        expect(after.poolCount).toBe(before.poolCount - 1);
        expect(after.history.at(-1)).toMatchObject({
          kind: "drew",
          playerId: "host",
        });
        expect(after.history.at(-1)?.message).toContain("auto-drew a tile because no move was possible");
      } else {
        expect(after.currentPlayerId).toBe("host");
        expect(after.version).toBe(before.version);
        expect(after.myRack).toEqual(before.myRack);
        expect(after.poolCount).toBe(before.poolCount);
        expect(after.history).toEqual(before.history);
      }
    });
  }

  it("does not auto-draw a blocked current player after Auto-draw is turned off", async () => {
    const room = await createStartedRoom();
    await replaceWithScenario(room, scenarios[0]!);
    expect(await room.setAssist("host", hostToken, "auto-draw", true)).toEqual({ ok: true });
    expect(await room.setAssist("host", hostToken, "auto-draw", false)).toEqual({ ok: true });

    const before = await room.getPublicState("host", hostToken);
    expect(before.noMovePossible).toBe(true);
    expect(before.enabledAssists).toEqual(["no-move-alert"]);
    expect(await alarmAt(room)).toBe(before.turnDeadline);

    expect(await runDurableObjectAlarm(room)).toBe(true);
    const after = await room.getPublicState("host", hostToken);
    expect(after.version).toBe(before.version);
    expect(after.currentPlayerId).toBe("host");
    expect(after.myRack).toEqual(before.myRack);
  });

  it("does not auto-draw for a blocked player who is not the current player", async () => {
    const room = await createStartedRoom();
    await replaceWithScenario(room, scenarios[0]!);
    expect(await room.setAssist("guest", guestToken, "auto-draw", true)).toEqual({ ok: true });

    const hostBefore = await room.getPublicState("host", hostToken);
    const guestBefore = await room.getPublicState("guest", guestToken);
    expect(hostBefore.currentPlayerId).toBe("host");
    expect(guestBefore.noMovePossible).toBe(false);
    expect(await alarmAt(room)).toBe(hostBefore.turnDeadline);

    expect(await runDurableObjectAlarm(room)).toBe(true);
    const hostAfter = await room.getPublicState("host", hostToken);
    expect(hostAfter.version).toBe(hostBefore.version);
    expect(hostAfter.currentPlayerId).toBe("host");
  });

  it("rechecks the live game state before executing an auto-draw alarm", async () => {
    const room = await createStartedRoom();
    await replaceWithScenario(room, scenarios[0]!, true);
    const blocked = await room.getPublicState("host", hostToken);
    expect(blocked.noMovePossible).toBe(true);

    await runInDurableObject(room, async (_instance, state) => {
      const row = state.storage.sql.exec<{ json: string }>(
        "SELECT json FROM game_state WHERE singleton = 1",
      ).one();
      const stored = JSON.parse(row.json) as StoredGame;
      const host = stored.players.find((player) => player.id === "host");
      if (!host) throw new Error("Expected host in stored game.");
      host.rack = ["coral-10-1", "sun-10-1", "ocean-10-1"];
      host.opened = false;
      stored.version += 1;
      stored.updatedAt = Date.now();
      state.storage.sql.exec(
        "UPDATE game_state SET json = ?, updated_at = ? WHERE singleton = 1",
        JSON.stringify(stored),
        stored.updatedAt,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(room);

    const beforeAlarm = await room.getPublicState("host", hostToken);
    expect(beforeAlarm.noMovePossible).toBe(false);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    const afterAlarm = await room.getPublicState("host", hostToken);
    expect(afterAlarm.currentPlayerId).toBe("host");
    expect(afterAlarm.version).toBe(beforeAlarm.version);
    expect(afterAlarm.myRack).toEqual(beforeAlarm.myRack);
  });

  it("schedules the next player's auto-draw through the real committed-turn transition", async () => {
    const room = await createStartedRoom();
    await replaceWithScenario(room, scenarios[4]!);
    await runInDurableObject(room, (_instance, state) => {
      const row = state.storage.sql.exec<{ json: string }>(
        "SELECT json FROM game_state WHERE singleton = 1",
      ).one();
      const stored = JSON.parse(row.json) as StoredGame;
      const host = stored.players.find((player) => player.id === "host");
      const guest = stored.players.find((player) => player.id === "guest");
      if (!host || !guest) throw new Error("Expected both test players in stored game.");
      guest.rack = ["coral-2-2", "sun-3-2"];
      guest.opened = true;
      guest.enabledAssists = ["no-move-alert", "auto-draw"];

      const occupied = new Set([...stored.board.flatMap((item) => item.tileIds), ...host.rack, ...guest.rack]);
      stored.pool = Object.keys(stored.tiles).filter((tileId) => !occupied.has(tileId));
      stored.version += 1;
      stored.updatedAt = Date.now();
      state.storage.sql.exec(
        "UPDATE game_state SET json = ?, updated_at = ? WHERE singleton = 1",
        JSON.stringify(stored),
        stored.updatedAt,
      );
    });
    await evictDurableObject(room);

    expect(await room.act("host", hostToken, {
      type: "commit",
      board: [set("host-play", ["coral-1-1", "sun-1-1", "ocean-1-1"])],
    })).toEqual({ ok: true });

    const guestBeforeAlarm = await room.getPublicState("guest", guestToken);
    expect(guestBeforeAlarm.currentPlayerId).toBe("guest");
    expect(guestBeforeAlarm.noMovePossible).toBe(true);
    expect(await alarmAt(room)).toBeLessThan(guestBeforeAlarm.turnDeadline!);

    expect(await runDurableObjectAlarm(room)).toBe(true);
    const guestAfterAlarm = await room.getPublicState("guest", guestToken);
    expect(guestAfterAlarm.currentPlayerId).toBe("host");
    expect(guestAfterAlarm.myRack).toHaveLength(guestBeforeAlarm.myRack.length + 1);
    expect(guestAfterAlarm.poolCount).toBe(guestBeforeAlarm.poolCount - 1);
    expect(guestAfterAlarm.history.at(-1)?.message).toContain("auto-drew a tile because no move was possible");
  });
});
