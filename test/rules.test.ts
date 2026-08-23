import { describe, expect, it } from "vitest";
import {
  createTileSet,
  hasLegalMove,
  rackPenalty,
  resolveWildcardAssignments,
  validateMeld,
  validateTurn,
} from "../src/shared/rules";
import {
  TILE_COLORS,
  TILE_COPIES_PER_NUMBER_AND_COLOR,
  TILE_NUMBER_MAX,
  TILE_NUMBER_MIN,
  TILE_SET_SIZE,
  WILDCARD_TILE_COUNT,
} from "../src/shared/types";
import type { Meld } from "../src/shared/types";

const tiles = createTileSet();
const meld = (id: string, tileIds: string[]): Meld => ({ id, tileIds });

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

    const wildcards = allTiles.filter((tile) => tile.wildcard);
    expect(wildcards).toHaveLength(WILDCARD_TILE_COUNT);
    expect(wildcards).toEqual([
      { id: "wildcard-1", color: null, value: null, wildcard: true },
      { id: "wildcard-2", color: null, value: null, wildcard: true },
    ]);
  });
});

describe("meld validation", () => {
  it("accepts groups of three or four distinct colors", () => {
    expect(validateMeld(["coral-8-1", "sun-8-1", "ocean-8-1"], tiles)).toMatchObject({ valid: true, kind: "group", points: 24 });
    expect(validateMeld(["coral-8-1", "sun-8-1", "ocean-8-1", "ink-8-1"], tiles)).toMatchObject({ valid: true, kind: "group", points: 32 });
  });

  it("rejects duplicate colors in a group", () => {
    expect(validateMeld(["coral-8-1", "coral-8-2", "ocean-8-1"], tiles).valid).toBe(false);
  });

  it("accepts ordered runs and positional wildcards", () => {
    expect(validateMeld(["ocean-4-1", "ocean-5-1", "ocean-6-1", "ocean-7-1"], tiles)).toMatchObject({ valid: true, kind: "run", points: 22 });
    expect(validateMeld(["ocean-10-1", "wildcard-1", "ocean-12-1"], tiles)).toMatchObject({ valid: true, kind: "run", points: 33 });
  });

  it("rejects unordered and out-of-range runs", () => {
    expect(validateMeld(["ocean-4-1", "ocean-6-1", "ocean-5-1"], tiles).valid).toBe(false);
    expect(validateMeld(["ocean-12-1", "ocean-13-1", "wildcard-1"], tiles).valid).toBe(false);
    expect(validateMeld(["wildcard-1", "ocean-1-1", "ocean-2-1"], tiles).valid).toBe(false);
  });

  it("scores a wildcard by the value it represents", () => {
    expect(validateMeld(["coral-7-1", "wildcard-1", "ocean-7-1"], tiles)).toMatchObject({ valid: true, kind: "group", points: 21 });
  });

  it("resolves the exact tile represented by a wildcard in a run", () => {
    expect(resolveWildcardAssignments(["ocean-7-1", "wildcard-1", "ocean-9-1"], tiles)).toEqual({
      "wildcard-1": { value: 8, color: "ocean", possibleColors: ["ocean"] },
    });
  });

  it("chooses a stable legal replacement color for a wildcard in a group of three", () => {
    expect(resolveWildcardAssignments(["coral-7-1", "sun-7-1", "wildcard-1"], tiles)).toEqual({
      "wildcard-1": { value: 7, color: "ocean", possibleColors: ["ocean", "ink"] },
    });
  });

  it("resolves the one missing color in a group of four", () => {
    expect(resolveWildcardAssignments(["coral-7-1", "sun-7-1", "ocean-7-1", "wildcard-1"], tiles)).toEqual({
      "wildcard-1": { value: 7, color: "ink", possibleColors: ["ink"] },
    });
  });
});

describe("turn validation", () => {
  it("rejects committing without playing a rack tile", () => {
    const old = meld("old", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
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
    const oldGroup = meld("group", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    const oldRun = meld("run", ["coral-6-1", "coral-7-1", "coral-8-1"]);
    const rearranged = [
      meld("long-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1"]),
      meld("short-group", ["sun-5-1", "ocean-5-1"]),
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
    const opening = meld("new", ["coral-10-1", "sun-10-1", "ocean-10-1"]);
    expect(validateTurn({ previousBoard: [], proposedBoard: [opening], rack: opening.tileIds, opened: false, tiles })).toMatchObject({ valid: true, openingPoints: 30 });
  });

  it("accepts a qualifying opening and a table extension in the same turn", () => {
    const previousBoard = [
      meld("old-run-1", ["ink-8-1", "ink-9-1", "ink-10-2", "ink-11-1"]),
      meld("old-run-2", ["ink-4-1", "ink-5-2", "ink-6-2"]),
    ];
    const proposedBoard = [
      meld("extended-run", ["ink-8-1", "ink-9-1", "ink-10-2", "ink-11-1", "ink-12-1"]),
      previousBoard[1]!,
      meld("opening-fives", ["coral-5-2", "sun-5-1", "ocean-5-1"]),
      meld("opening-thirteens", ["coral-13-1", "ocean-13-2", "ink-13-2"]),
    ];
    const rack = [
      "ink-12-1",
      "coral-5-2", "sun-5-1", "ocean-5-1",
      "coral-13-1", "ocean-13-2", "ink-13-2",
    ];

    expect(validateTurn({ previousBoard, proposedBoard, rack, opened: false, tiles })).toEqual({
      valid: true,
      reason: null,
      playedTileIds: rack,
      openingPoints: 54,
    });
  });

  it("rejects an opening below 30", () => {
    const opening = meld("new", ["coral-9-1", "sun-9-1", "ocean-9-1"]);
    expect(validateTurn({ previousBoard: [], proposedBoard: [opening], rack: opening.tileIds, opened: false, tiles })).toMatchObject({ valid: false, openingPoints: 27 });
  });

  it("does not count a mixed table-and-rack meld toward the opening minimum", () => {
    const old = meld("old", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    const changed = meld("changed", ["coral-5-1", "sun-5-1", "ocean-5-1", "ink-5-1"]);
    const ownGroup = meld("own", ["coral-9-1", "sun-9-1", "ocean-9-1"]);
    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: [changed, ownGroup],
      rack: ["ink-5-1", ...ownGroup.tileIds],
      opened: false,
      tiles,
    })).toMatchObject({ valid: false, openingPoints: 27 });
  });

  it("allows a player who has opened to rearrange all table tiles", () => {
    const oldGroup = meld("group", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    const oldRun = meld("run", ["coral-6-1", "coral-7-1", "coral-8-1"]);
    const proposed = [
      meld("long-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1"]),
      meld("new-group", ["sun-5-1", "ocean-5-1", "ink-5-1"]),
    ];
    expect(validateTurn({ previousBoard: [oldGroup, oldRun], proposedBoard: proposed, rack: ["ink-5-1"], opened: true, tiles }).valid).toBe(true);
  });

  it("requires every old table tile to remain on the table", () => {
    const old = meld("old", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    const proposed = meld("new", ["sun-5-1", "ocean-5-1", "ink-5-1"]);
    expect(validateTurn({ previousBoard: [old], proposedBoard: [proposed], rack: ["ink-5-1"], opened: true, tiles }).valid).toBe(false);
  });

  it("allows an opened player to free and immediately replay a table wildcard", () => {
    const old = meld("old", ["ocean-7-1", "wildcard-1", "ocean-9-1"]);
    const proposed = [
      meld("repaired", ["ocean-7-1", "ocean-8-1", "ocean-9-1"]),
      meld("wildcard-replayed", ["coral-5-1", "sun-5-1", "wildcard-1"]),
    ];
    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: proposed,
      rack: ["ocean-8-1", "coral-5-1", "sun-5-1"],
      opened: true,
      tiles,
    }).valid).toBe(true);
  });

  it("does not allow a player to retrieve a table wildcard before opening", () => {
    const old = meld("old", ["ocean-7-1", "wildcard-1", "ocean-9-1"]);
    const proposed = [
      meld("repaired", ["ocean-7-1", "ocean-8-1", "ocean-9-1"]),
      meld("wildcard-replayed", ["coral-10-1", "sun-10-1", "wildcard-1"]),
    ];
    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: proposed,
      rack: ["ocean-8-1", "coral-10-1", "sun-10-1"],
      opened: false,
      tiles,
    }).valid).toBe(false);
  });

  it("requires a retrieved wildcard to remain in a valid table meld", () => {
    const old = meld("old", ["ocean-7-1", "wildcard-1", "ocean-9-1"]);
    const proposed = meld("repaired", ["ocean-7-1", "ocean-8-1", "ocean-9-1"]);
    expect(validateTurn({
      previousBoard: [old],
      proposedBoard: [proposed],
      rack: ["ocean-8-1"],
      opened: true,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "A retrieved wildcard must be played in another valid meld during the same turn.",
    });
  });
});

describe("rack scoring", () => {
  it("counts wildcards as 30 points", () => {
    expect(rackPenalty(["wildcard-1", "coral-13-1", "sun-2-1"], tiles)).toBe(45);
  });
});

describe("legal move search", () => {
  it("requires unopened players to reach 30 across one or more rack-only melds", () => {
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

  it("finds a move that requires rearranging existing table melds", () => {
    expect(hasLegalMove({
      board: [
        meld("coral-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1", "coral-9-1"]),
        meld("sun-run", ["sun-5-1", "sun-6-1", "sun-7-1", "sun-8-1", "sun-9-1"]),
      ],
      rack: ["ocean-9-1"],
      opened: true,
      tiles,
    })).toBe(true);
  });

  it("reports no move when an opened player's tiles cannot join or rearrange the table", () => {
    expect(hasLegalMove({
      board: [meld("group", ["coral-5-1", "sun-5-1", "ocean-5-1"])],
      rack: ["coral-1-1", "sun-2-1"],
      opened: true,
      tiles,
    })).toBe(false);
  });
});
