import { describe, expect, it } from "vitest";
import { createTileSet, validateMeld, validateTurn } from "../src/shared/rules";
import { TILE_COLORS } from "../src/shared/types";
import type { Meld } from "../src/shared/types";

const tiles = createTileSet();
const meld = (id: string, tileIds: string[]): Meld => ({ id, tileIds });

describe("meld state space", () => {
  it("accepts every natural three- and four-color group", () => {
    const colorSelections = [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
      [0, 1, 2, 3],
    ];

    for (let value = 1; value <= 13; value += 1) {
      for (const selection of colorSelections) {
        const tileIds = selection.map((index) => `${TILE_COLORS[index]}-${value}-1`);
        expect(validateMeld(tileIds, tiles), tileIds.join(",")).toMatchObject({
          valid: true,
          kind: "group",
          points: value * tileIds.length,
        });
      }
    }
  });

  it("rejects a repeated color in every numbered group", () => {
    for (let value = 1; value <= 13; value += 1) {
      const tileIds = [`coral-${value}-1`, `coral-${value}-2`, `ocean-${value}-1`];
      expect(validateMeld(tileIds, tiles).valid, tileIds.join(",")).toBe(false);
    }
  });

  it("accepts every natural contiguous run", () => {
    for (const color of TILE_COLORS) {
      for (let start = 1; start <= 11; start += 1) {
        for (let end = start + 2; end <= 13; end += 1) {
          const tileIds = Array.from(
            { length: end - start + 1 },
            (_, index) => `${color}-${start + index}-1`,
          );
          const points = ((end - start + 1) * (start + end)) / 2;
          expect(validateMeld(tileIds, tiles), tileIds.join(",")).toMatchObject({
            valid: true,
            kind: "run",
            points,
          });
        }
      }
    }
  });

  it("accepts a joker in every position of every three-tile run", () => {
    for (const color of TILE_COLORS) {
      for (let start = 1; start <= 11; start += 1) {
        for (let jokerIndex = 0; jokerIndex < 3; jokerIndex += 1) {
          const tileIds = Array.from(
            { length: 3 },
            (_, index) => index === jokerIndex ? "joker-1" : `${color}-${start + index}-1`,
          );
          expect(validateMeld(tileIds, tiles), tileIds.join(",")).toMatchObject({
            valid: true,
            kind: "run",
            points: start * 3 + 3,
          });
        }
      }
    }
  });

  it("rejects gaps, descending runs, boundary wrapping, and all-joker melds", () => {
    for (const color of TILE_COLORS) {
      for (let start = 1; start <= 10; start += 1) {
        expect(validateMeld([
          `${color}-${start}-1`,
          `${color}-${start + 1}-1`,
          `${color}-${start + 3}-1`,
        ], tiles).valid).toBe(false);
      }
      for (let start = 1; start <= 11; start += 1) {
        expect(validateMeld([
          `${color}-${start + 2}-1`,
          `${color}-${start + 1}-1`,
          `${color}-${start}-1`,
        ], tiles).valid).toBe(false);
      }
    }

    expect(validateMeld(["joker-1", "coral-1-1", "coral-2-1"], tiles).valid).toBe(false);
    expect(validateMeld(["coral-12-1", "coral-13-1", "joker-1"], tiles).valid).toBe(false);
    expect(validateMeld(["joker-1", "joker-2", "joker-1"], tiles).valid).toBe(false);
  });
});

describe("turn state transitions", () => {
  it("adds independent rack-only melds together to reach exactly 30", () => {
    const first = meld("fives-1", ["coral-5-1", "sun-5-1", "ocean-5-1"]);
    const second = meld("fives-2", ["coral-5-2", "sun-5-2", "ink-5-1"]);
    const rack = [...first.tileIds, ...second.tileIds];

    expect(validateTurn({
      previousBoard: [],
      proposedBoard: [first, second],
      rack,
      opened: false,
      tiles,
    })).toEqual({ valid: true, reason: null, playedTileIds: rack, openingPoints: 30 });
  });

  it("allows full table rearrangement after qualifying rack-only opening melds", () => {
    const previousBoard = [
      meld("old-group", ["coral-5-1", "sun-5-1", "ocean-5-1"]),
      meld("old-run", ["coral-6-1", "coral-7-1", "coral-8-1"]),
    ];
    const opening = meld("opening", ["coral-10-1", "sun-10-1", "ocean-10-1"]);
    const rack = ["coral-9-1", "ink-5-1", ...opening.tileIds];
    const proposedBoard = [
      meld("long-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1", "coral-9-1"]),
      meld("new-group", ["sun-5-1", "ocean-5-1", "ink-5-1"]),
      opening,
    ];

    expect(validateTurn({ previousBoard, proposedBoard, rack, opened: false, tiles })).toEqual({
      valid: true,
      reason: null,
      playedTileIds: ["coral-9-1", "ink-5-1", ...opening.tileIds],
      openingPoints: 30,
    });
  });

  it("does not count tiles added to old table melds toward an opening", () => {
    const previousBoard = [meld("old-run", ["coral-10-1", "coral-11-1", "coral-12-1"])];
    const proposedBoard = [
      meld("extended-run", ["coral-9-1", "coral-10-1", "coral-11-1", "coral-12-1", "coral-13-1"]),
    ];

    expect(validateTurn({
      previousBoard,
      proposedBoard,
      rack: ["coral-9-1", "coral-13-1"],
      opened: false,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "Your opening melds total 0; you need at least 30.",
      openingPoints: 0,
    });
  });

  it("counts only rack-only melds when a draft also contains mixed melds", () => {
    const previousBoard = [meld("old-group", ["coral-5-1", "sun-5-1", "ocean-5-1"])];
    const rackOnly = meld("rack-only", ["coral-9-1", "sun-9-1", "ocean-9-1"]);
    const proposedBoard = [
      meld("mixed", [...previousBoard[0]!.tileIds, "ink-5-1"]),
      rackOnly,
    ];

    expect(validateTurn({
      previousBoard,
      proposedBoard,
      rack: ["ink-5-1", ...rackOnly.tileIds],
      opened: false,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "Your opening melds total 27; you need at least 30.",
      openingPoints: 27,
    });
  });

  it("requires every prior table tile to survive a transition", () => {
    const previousBoard = [meld("old", ["coral-5-1", "sun-5-1", "ocean-5-1"] )];
    const proposedBoard = [meld("replacement", ["coral-5-1", "sun-5-1", "ink-5-1"] )];

    expect(validateTurn({
      previousBoard,
      proposedBoard,
      rack: ["ink-5-1"],
      opened: true,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "Tiles already on the table cannot return to a rack.",
    });
  });

  it("rejects duplicate, foreign, and unknown tiles", () => {
    expect(validateTurn({
      previousBoard: [],
      proposedBoard: [meld("duplicate", ["coral-10-1", "sun-10-1", "coral-10-1"])],
      rack: ["coral-10-1", "sun-10-1"],
      opened: false,
      tiles,
    })).toMatchObject({ valid: false, reason: "Every tile can appear only once on the table." });

    expect(validateTurn({
      previousBoard: [],
      proposedBoard: [meld("foreign", ["coral-10-1", "sun-10-1", "ocean-10-1"])],
      rack: ["coral-10-1", "sun-10-1"],
      opened: false,
      tiles,
    })).toMatchObject({ valid: false, reason: "The table contains a tile that is not in your rack." });

    expect(validateTurn({
      previousBoard: [],
      proposedBoard: [meld("unknown", ["coral-10-1", "sun-10-1", "missing-10-1"])],
      rack: ["coral-10-1", "sun-10-1", "missing-10-1"],
      opened: false,
      tiles,
    })).toMatchObject({ valid: false, reason: "Meld 1: This meld contains an unknown tile." });
  });

  it("requires the complete proposed board to be valid even after a qualifying opening", () => {
    const previousBoard = [meld("old", ["coral-5-1", "sun-5-1", "ocean-5-1"] )];
    const opening = meld("opening", ["coral-10-1", "sun-10-1", "ocean-10-1"]);

    expect(validateTurn({
      previousBoard,
      proposedBoard: [meld("broken-old", [...previousBoard[0]!.tileIds, "coral-4-1"]), opening],
      rack: ["coral-4-1", ...opening.tileIds],
      opened: false,
      tiles,
    })).toMatchObject({ valid: false, reason: expect.stringMatching(/^Meld 1:/) });
  });

  it("allows opened players to extend the table without reporting opening points", () => {
    const previousBoard = [meld("old", ["ocean-7-1", "ocean-8-1", "ocean-9-1"] )];
    const proposedBoard = [meld("extended", ["ocean-6-1", ...previousBoard[0]!.tileIds])];

    expect(validateTurn({
      previousBoard,
      proposedBoard,
      rack: ["ocean-6-1"],
      opened: true,
      tiles,
    })).toEqual({
      valid: true,
      reason: null,
      playedTileIds: ["ocean-6-1"],
      openingPoints: 0,
    });
  });

  it("rejects a transition with no newly played rack tile", () => {
    const previousBoard = [
      meld("old-group", ["coral-5-1", "sun-5-1", "ocean-5-1"]),
      meld("old-run", ["coral-6-1", "coral-7-1", "coral-8-1"]),
    ];
    const proposedBoard = [
      meld("rearranged-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1"]),
      meld("incomplete", ["sun-5-1", "ocean-5-1"]),
    ];

    expect(validateTurn({
      previousBoard,
      proposedBoard,
      rack: ["ink-5-1"],
      opened: true,
      tiles,
    })).toMatchObject({
      valid: false,
      reason: "Play at least one tile, or draw to end your turn.",
    });
  });

  it("does not mutate authoritative or draft state while validating", () => {
    const previousBoard = [meld("old", ["coral-5-1", "sun-5-1", "ocean-5-1"] )];
    const opening = meld("opening", ["coral-10-1", "sun-10-1", "ocean-10-1"]);
    const proposedBoard = [previousBoard[0]!, opening];
    const rack = [...opening.tileIds];
    const before = structuredClone({ previousBoard, proposedBoard, rack, tiles });

    validateTurn({ previousBoard, proposedBoard, rack, opened: false, tiles });

    expect({ previousBoard, proposedBoard, rack, tiles }).toEqual(before);
  });

  it("enforces board and meld count limits before accepting state", () => {
    const tooManyMelds = Array.from(
      { length: 107 },
      (_, index) => meld(`meld-${index}`, ["coral-1-1"]),
    );
    expect(validateTurn({
      previousBoard: [],
      proposedBoard: tooManyMelds,
      rack: ["coral-1-1"],
      opened: true,
      tiles,
    })).toMatchObject({ valid: false, reason: "The table contains too many melds." });
  });
});
