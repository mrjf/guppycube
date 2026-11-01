import { describe, expect, it } from "vitest";
import {
  createTileSet,
  findLegalMoves,
  hasLegalMove,
  validateTurn,
} from "../src/shared/rules";
import type { GameSet } from "../src/shared/types";

const tiles = createTileSet();
const set = (id: string, tileIds: string[]): GameSet => ({ id, tileIds });

interface Scenario {
  name: string;
  board?: GameSet[];
  rack: string[];
  opened: boolean;
  legal: boolean;
  kind?: "opening" | "rack-set" | "table-extension" | "rearrangement";
}

const scenarios: Scenario[] = [
  { name: "empty rack", rack: [], opened: true, legal: false },
  { name: "one loose tile before opening", rack: ["coral-13-1"], opened: false, legal: false },
  { name: "three low same-number tiles below 30", rack: ["coral-9-1", "sun-9-1", "ocean-9-1"], opened: false, legal: false },
  { name: "exact 30 point group", rack: ["coral-10-1", "sun-10-1", "ocean-10-1"], opened: false, legal: true, kind: "opening" },
  { name: "exact 30 point run", rack: ["coral-9-1", "coral-10-1", "coral-11-1"], opened: false, legal: true, kind: "opening" },
  { name: "high run at the bottom edge", rack: ["ink-1-1", "ink-2-1", "ink-3-1", "sun-13-1"], opened: false, legal: false },
  { name: "high run at the top edge", rack: ["ink-11-1", "ink-12-1", "ink-13-1", "sun-1-1"], opened: false, legal: true, kind: "opening" },
  { name: "two disjoint groups whose points reach 30", rack: ["coral-5-1", "sun-5-1", "ocean-5-1", "coral-5-2", "sun-5-2", "ink-5-1"], opened: false, legal: true, kind: "opening" },
  { name: "four low same-number tiles still cannot reach 30", rack: ["coral-5-1", "sun-5-1", "ocean-5-1", "ink-5-1", "coral-1-1"], opened: false, legal: false },
  { name: "same-color duplicates cannot make a group", rack: ["coral-8-1", "coral-8-2", "sun-8-1"], opened: false, legal: false },
  { name: "wildcard completes a 30 point group", rack: ["coral-10-1", "sun-10-1", "wilcard-1"], opened: false, legal: true, kind: "opening" },
  { name: "wildcard starts a top-edge run", rack: ["wilcard-1", "coral-12-1", "coral-13-1"], opened: false, legal: true, kind: "opening" },
  { name: "wildcard cannot wrap below one", rack: ["wilcard-1", "coral-1-1", "coral-2-1"], opened: false, legal: false },
  { name: "two wildcards can fill a group", rack: ["coral-7-1", "wilcard-1", "wilcard-2"], opened: false, legal: false },
  { name: "rack-only low set is legal after opening", rack: ["coral-1-1", "sun-1-1", "ocean-1-1"], opened: true, legal: true, kind: "rack-set" },
  { name: "rack-only set is legal alongside existing felt", board: [set("old", ["coral-5-1", "sun-5-1", "ocean-5-1"])], rack: ["coral-1-1", "sun-1-1", "ocean-1-1"], opened: true, legal: true, kind: "rack-set" },
  { name: "rack-only long run is legal after opening", rack: ["ocean-3-1", "ocean-4-1", "ocean-5-1", "sun-13-1"], opened: true, legal: true, kind: "rack-set" },
  { name: "opened player extends a group", board: [set("group", ["coral-5-1", "sun-5-1", "ocean-5-1"])], rack: ["ink-5-1", "coral-1-1"], opened: true, legal: true, kind: "table-extension" },
  { name: "opened player extends a run at its left edge", board: [set("run", ["ocean-5-1", "ocean-6-1", "ocean-7-1"])], rack: ["ocean-4-1"], opened: true, legal: true, kind: "table-extension" },
  { name: "opened player extends a run at its right edge", board: [set("run", ["ocean-5-1", "ocean-6-1", "ocean-7-1"])], rack: ["ocean-8-1"], opened: true, legal: true, kind: "table-extension" },
  { name: "opened player cannot insert a duplicate run value", board: [set("run", ["ocean-5-1", "ocean-6-1", "ocean-7-1"])], rack: ["ocean-6-2"], opened: true, legal: false },
  { name: "opened player can replace and replay a felt wildcard", board: [set("run", ["ocean-7-1", "wilcard-1", "ocean-9-1"])], rack: ["ocean-8-1", "coral-5-1", "sun-5-1"], opened: true, legal: true, kind: "rearrangement" },
  { name: "opened player can split two runs around one rack tile", board: [
    set("coral-run", ["coral-5-1", "coral-6-1", "coral-7-1", "coral-8-1", "coral-9-1"]),
    set("sun-run", ["sun-5-1", "sun-6-1", "sun-7-1", "sun-8-1", "sun-9-1"]),
  ], rack: ["ocean-9-1"], opened: true, legal: true, kind: "rearrangement" },
  { name: "opened player cannot leave a two-tile felt fragment", board: [
    set("fives", ["coral-5-1", "sun-5-1", "ocean-5-1"]),
    set("sun-run", ["sun-6-1", "sun-7-1", "sun-8-1"]),
  ], rack: ["sun-4-1"], opened: true, legal: false },
  { name: "opened player cannot use a rack tile that only makes an invalid set", board: [set("group", ["coral-5-1", "sun-5-1", "ocean-5-1"])], rack: ["coral-1-1", "sun-2-1"], opened: true, legal: false },
  { name: "unopened player ignores the felt but must preserve it", board: [set("old", ["coral-5-1", "sun-5-1", "ocean-5-1"])], rack: ["coral-10-1", "sun-10-1", "ocean-10-1"], opened: false, legal: true, kind: "opening" },
  { name: "unopened player cannot extend the felt", board: [set("old", ["coral-5-1", "sun-5-1", "ocean-5-1"])], rack: ["ink-5-1", "coral-1-1"], opened: false, legal: false },
  { name: "unopened player can open while leaving a felt wildcard alone", board: [set("old", ["ocean-7-1", "wilcard-1", "ocean-9-1"])], rack: ["ocean-8-1", "coral-10-1", "sun-10-1", "ocean-10-1"], opened: false, legal: true, kind: "opening" },
  { name: "empty felt plus unrelated opened rack has no move", rack: ["coral-1-1", "sun-2-1", "ocean-4-1"], opened: true, legal: false },
  { name: "empty pool does not change move legality", rack: ["ink-2-1", "sun-4-1", "ocean-9-1"], opened: true, legal: false },
  { name: "four-color group is playable", rack: ["coral-13-1", "sun-13-1", "ocean-13-1", "ink-13-1"], opened: true, legal: true, kind: "rack-set" },
  { name: "run longer than thirteen is impossible", rack: Array.from({ length: 14 }, (_, index) => `coral-${(index % 13) + 1}-1`), opened: true, legal: true, kind: "rack-set" },
];

describe("rack + felt legal-move analysis", () => {
  it.each(scenarios)("$name", (scenario) => {
    const analysis = findLegalMoves({
      board: scenario.board ?? [],
      rack: scenario.rack,
      opened: scenario.opened,
      tiles,
    }, { maxMoves: 12 });

    expect(analysis.legal).toBe(scenario.legal);
    expect(hasLegalMove({
      board: scenario.board ?? [],
      rack: scenario.rack,
      opened: scenario.opened,
      tiles,
    })).toBe(scenario.legal);
    if (scenario.legal) expect(analysis.reason).toBeNull();
    else expect(typeof analysis.reason).toBe("string");

    for (const move of analysis.moves) {
      expect(validateTurn({
        previousBoard: scenario.board ?? [],
        proposedBoard: move.board,
        rack: scenario.rack,
        opened: scenario.opened,
        tiles,
      }).valid).toBe(true);
      expect(move.playedTileIds.length).toBeGreaterThan(0);
    }
    if (scenario.kind) expect(analysis.moves.some((move) => move.kind === scenario.kind)).toBe(true);
  });

  it("returns a complete explanation for a wildcard rearrangement", () => {
    const analysis = findLegalMoves({
      board: [set("old", ["ocean-7-1", "wilcard-1", "ocean-9-1"])],
      rack: ["ocean-8-1", "coral-5-1", "sun-5-1"],
      opened: true,
      tiles,
    }, { maxMoves: 50 });
    const move = analysis.moves.find((candidate) => candidate.kind === "rearrangement");
    expect(move).toBeDefined();
    expect(move?.playedTileIds).toContain("ocean-8-1");
    expect(move?.board.flatMap((item) => item.tileIds)).toContain("wilcard-1");
    expect(move?.board.every((item) => item.tileIds.every((tileId) => tiles[tileId]))).toBe(true);
  });

  it("flags result truncation without changing the existence answer", () => {
    const analysis = findLegalMoves({
      board: [],
      rack: ["coral-10-1", "sun-10-1", "ocean-10-1", "coral-11-1", "sun-11-1", "ocean-11-1"],
      opened: false,
      tiles,
    }, { maxMoves: 1 });
    expect(analysis.legal).toBe(true);
    expect(analysis.moves).toHaveLength(1);
    expect(analysis.truncated).toBe(true);
  });
});
