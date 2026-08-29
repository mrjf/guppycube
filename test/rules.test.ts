import { describe, expect, it } from "vitest";
import {
  createTileSet,
  hasLegalMove,
  rackPenalty,
  resolveWilcardAssignments,
  validateSet,
  validateTurn,
} from "../src/shared/rules";
import {
  TILE_COLORS,
  TILE_COPIES_PER_NUMBER_AND_COLOR,
  TILE_NUMBER_MAX,
  TILE_NUMBER_MIN,
  TILE_SET_SIZE,
  WILCARD_TILE_COUNT,
} from "../src/shared/types";
import type { GameSet } from "../src/shared/types";

const tiles = createTileSet();
const set = (id: string, tileIds: string[]): GameSet => ({ id, tileIds });

describe("tile set", () => {
  it("uses the configured 106-tile distribution", () => {
    const allTiles = Object.values(tiles);
    expect(allTiles).toHaveLength(TILE_SET_SIZE);

    for (const color of TILE_COLORS) {
      for (let value = TILE_NUMBER_MIN; value <= TILE_NUMBER_MAX; value += 1) {
        expect(allTiles.filter((tile) => tile.color === color && tile.value === value)).toHaveLength(
          TILE_COPIES_PER_NUMBER_AND_COLOR,
        );
      }
    }

    const wilcards = allTiles.filter((tile) => tile.wilcard);
    expect(wilcards).toHaveLength(WILCARD_TILE_COUNT);
    expect(wilcards).toEqual([
      { id: "wilcard-1", color: null, value: null, wilcard: true },
      { id: "wilcard-2", color: null, value: null, wilcard: true },
    ]);
  });
});

describe("set validation", () => {
  it("accepts groups of three or four distinct colors", () => {
    expect(validateSet(["coral-8-1", "sun-8-1", "ocean-8-1"], tiles)).toMatchObject({ valid: true, kind: "group", points: 24 });
    expect(validateSet(["coral-8-1", "sun-8-1", "ocean-8-1", "ink-8-1"], tiles)).toMatchObject({ valid: true, kind: "group", points: 32 });
  });

  it("rejects duplicate colors in a group", () => {
    expect(validateSet(["coral-8-1", "coral-8-2", "ocean-8-1"], tiles).valid).toBe(false);
  });

  it("accepts ordered runs and positional wilcards", () => {
    expect(validateSet(["ocean-4-1", "ocean-5-1", "ocean-6-1", "ocean-7-1"], tiles)).toMatchObject({ valid: true, kind: "run", points: 22 });
    expect(validateSet(["ocean-10-1", "wilcard-1", "ocean-12-1"], tiles)).toMatchObject({ valid: true, kind: "run", points: 33 });
  });

  it("rejects unordered and out-of-range runs", () => {
    expect(validateSet(["ocean-4-1", "ocean-6-1", "ocean-5-1"], tiles).valid).toBe(false);
    expect(validateSet(["ocean-12-1", "ocean-13-1", "wilcard-1"], tiles).valid).toBe(false);
    expect(validateSet(["wilcard-1", "ocean-1-1", "ocean-2-1"], tiles).valid).toBe(false);
  });

  it("scores a wilcard by the value it represents", () => {
    expect(validateSet(["coral-7-1", "wilcard-1", "ocean-7-1"], tiles)).toMatchObject({ valid: true, kind: "group", points: 21 });
  });

  it("resolves the exact tile represented by a wilcard in a run", () => {
    expect(resolveWilcardAssignments(["ocean-7-1", "wilcard-1", "ocean-9-1"], tiles)).toEqual({
      "wilcard-1": { value: 8, color: "ocean", possibleColors: ["ocean"] },
    });
  });

  it("chooses a stable legal replacement color for a wilcard in a group of three", () => {
    expect(resolveWilcardAssignments(["coral-7-1", "sun-7-1", "wilcard-1"], tiles)).toEqual({
      "wilcard-1": { value: 7, color: "ocean", possibleColors: ["ocean", "ink"] },
    });
  });

  it("resolves the one missing color in a group of four", () => {
    expect(resolveWilcardAssignments(["coral-7-1", "sun-7-1", "ocean-7-1", "wilcard-1"], tiles)).toEqual({
      "wilcard-1": { value: 7, color: "ink", possibleColors: ["ink"] },
    });
  });
});

describe("turn validation", () => {
  it("rejects committing without playing a rack tile", () => {
    const old = set("old", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: [old],
      rack: ["ink-5-1"],
      opened: true,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "Play at least one tile, or draw to end your turn.",
      playedTileIds: [],
    });
  });

  it("rejects rearranging table tiles without playing a rack tile", () => {
    const oldGroup = set("group", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    const oldRun = set("run", ["coral-6-1", "coral-7-1", "coral-8-1"]);
    const rearranged = [
      set("long-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1"]),
      set("short-group", ["sun-5-1", "ocean-5-1"]),
    ];
    expect(validateTurn({
      previousBoard: [oldGroup, oldRun],
      proposedBoard: rearranged,
      rack: ["ink-5-1"],
      opened: true,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "Play at least one tile, or draw to end your turn.",
      playedTileIds: [],
    });
  });

  it("accepts an opening play worth exactly 30", () => {
    const opening = set("new", ["coral-10-1", "sun-10-1", "ocean-10-1"]);
    expect(validateTurn({ previousBoard: [], proposedBoard: [opening], rack: opening.tileIds, opened: false, tiles })).toMatchObject({ valid: true, openingPoints: 30 });
  });

  it("rejects using an existing table set during the opening turn", () => {
    const previousBoard = [
      set("old-run-1", ["ink-8-1", "ink-9-1", "ink-10-2", "ink-11-1"]),
      set("old-run-2", ["ink-4-1", "ink-5-2", "ink-6-2"]),
    ];
    const proposedBoard = [
      set("extended-run", ["ink-8-1", "ink-9-1", "ink-10-2", "ink-11-1", "ink-12-1"]),
      previousBoard[1]!,
      set("opening-fives", ["coral-5-2", "sun-5-1", "ocean-5-1"]),
      set("opening-thirteens", ["coral-13-1", "ocean-13-2", "ink-13-2"]),
    ];
    const rack = [
      "ink-12-1",
      "coral-5-2", "sun-5-1", "ocean-5-1",
      "coral-13-1", "ocean-13-2", "ink-13-2",
    ];

    expect(validateTurn({ previousBoard, proposedBoard, rack, opened: false, tiles })).toMatchObject({
      valid: false,
      reason: "Your opening turn can only use tiles from your rack; existing sets must stay unchanged.",
    });
  });

  it("rejects reordering an existing set during the opening turn", () => {
    const old = set("old", ["wilcard-1", "ocean-2-1", "ocean-3-1"]);
    const opening = set("opening", ["coral-10-1", "sun-10-1", "ocean-10-1"]);

    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: [
        set("reordered", ["ocean-2-1", "ocean-3-1", "wilcard-1"]),
        opening,
      ],
      rack: opening.tileIds,
      opened: false,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "Your opening turn can only use tiles from your rack; existing sets must stay unchanged.",
    });
  });

  it("rejects an opening below 30", () => {
    const opening = set("new", ["coral-9-1", "sun-9-1", "ocean-9-1"]);
    expect(validateTurn({ previousBoard: [], proposedBoard: [opening], rack: opening.tileIds, opened: false, tiles })).toMatchObject({ valid: false, openingPoints: 27 });
  });

  it("rejects mixing a table set with rack tiles during the opening turn", () => {
    const old = set("old", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    const changed = set("changed", ["coral-5-1", "sun-5-1", "ocean-5-1", "ink-5-1"]);
    const ownGroup = set("own", ["coral-9-1", "sun-9-1", "ocean-9-1"]);
    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: [changed, ownGroup],
      rack: ["ink-5-1", ...ownGroup.tileIds],
      opened: false,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "Your opening turn can only use tiles from your rack; existing sets must stay unchanged.",
    });
  });

  it("allows a player who has opened to rearrange all table tiles", () => {
    const oldGroup = set("group", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    const oldRun = set("run", ["coral-6-1", "coral-7-1", "coral-8-1"]);
    const proposed = [
      set("long-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1"]),
      set("new-group", ["sun-5-1", "ocean-5-1", "ink-5-1"]),
    ];
    expect(validateTurn({ previousBoard: [oldGroup, oldRun], proposedBoard: proposed, rack: ["ink-5-1"], opened: true, tiles }).valid).toBe(true);
  });

  it("requires every old table tile to remain on the table", () => {
    const old = set("old", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    const proposed = set("new", ["sun-5-1", "ocean-5-1", "ink-5-1"]);
    expect(validateTurn({ previousBoard: [old], proposedBoard: [proposed], rack: ["ink-5-1"], opened: true, tiles }).valid).toBe(false);
  });

  it("allows an opened player to free and immediately replay a table wilcard", () => {
    const old = set("old", ["ocean-7-1", "wilcard-1", "ocean-9-1"]);
    const proposed = [
      set("repaired", ["ocean-7-1", "ocean-8-1", "ocean-9-1"]),
      set("wilcard-replayed", ["coral-5-1", "sun-5-1", "wilcard-1"]),
    ];
    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: proposed,
      rack: ["ocean-8-1", "coral-5-1", "sun-5-1"],
      opened: true,
      tiles,
    }).valid).toBe(true);
  });

  it("does not allow a player to retrieve a table wilcard before opening", () => {
    const old = set("old", ["ocean-7-1", "wilcard-1", "ocean-9-1"]);
    const proposed = [
      set("repaired", ["ocean-7-1", "ocean-8-1", "ocean-9-1"]),
      set("wilcard-replayed", ["coral-10-1", "sun-10-1", "wilcard-1"]),
    ];
    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: proposed,
      rack: ["ocean-8-1", "coral-10-1", "sun-10-1"],
      opened: false,
      tiles,
    }).valid).toBe(false);
  });

  it("requires a retrieved wilcard to remain in a valid table set", () => {
    const old = set("old", ["ocean-7-1", "wilcard-1", "ocean-9-1"]);
    const proposed = set("repaired", ["ocean-7-1", "ocean-8-1", "ocean-9-1"]);
    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: [proposed],
      rack: ["ocean-8-1"],
      opened: true,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "A retrieved wilcard must be played in another valid set during the same turn.",
    });
  });
});

describe("rack scoring", () => {
  it("counts wilcards as 30 points", () => {
    expect(rackPenalty(["wilcard-1", "coral-13-1", "sun-2-1"], tiles)).toBe(45);
  });
});

describe("legal move search", () => {
  it("requires unopened players to reach 30 across one or more rack-only sets", () => {
    expect(hasLegalMove({
      board: [],
      rack: ["coral-9-1", "sun-9-1", "ocean-9-1"],
      opened: false,
      tiles,
    })).toBe(false);
    expect(hasLegalMove({
      board: [],
      rack: ["coral-10-1", "sun-10-1", "ocean-10-1"],
      opened: false,
      tiles,
    })).toBe(true);
    expect(hasLegalMove({
      board: [],
      rack: [
        "coral-5-1", "sun-5-1", "ocean-5-1",
        "coral-5-2", "sun-5-2", "ink-5-1",
      ],
      opened: false,
      tiles,
    })).toBe(true);
  });

  it("finds a move that requires rearranging existing table sets", () => {
    expect(hasLegalMove({
      board: [
        set("coral-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1", "coral-9-1"]),
        set("sun-run", ["sun-5-1", "sun-6-1", "sun-7-1", "sun-8-1", "sun-9-1"]),
      ],
      rack: ["ocean-9-1"],
      opened: true,
      tiles,
    })).toBe(true);
  });

  it("reports no move when an opened player's tiles cannot join or rearrange the table", () => {
    expect(hasLegalMove({
      board: [set("group", ["coral-5-1", "sun-5-1", "ocean-5-1"])],
      rack: ["coral-1-1", "sun-2-1"],
      opened: true,
      tiles,
    })).toBe(false);
  });
});
