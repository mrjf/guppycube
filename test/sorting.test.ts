import { describe, expect, it } from "vitest";
import { createTileSet } from "../src/shared/rules";
import {
  findLinkedRackTileIds,
  groupSortedRackTileIds,
  normalizeMeldTileIds,
  sortTileIds,
} from "../src/shared/sorting";

const tiles = createTileSet();

describe("standard tile sorting", () => {
  it("sorts by the fixed color order and then number", () => {
    expect(sortTileIds(
      ["ink-2-1", "coral-9-1", "sun-4-1", "coral-3-1", "joker-1"],
      tiles,
      "color-first",
    )).toEqual(["coral-3-1", "coral-9-1", "sun-4-1", "ink-2-1", "joker-1"]);
  });

  it("sorts by number and then the same fixed color order", () => {
    expect(sortTileIds(
      ["ink-2-1", "ocean-1-1", "coral-2-1", "sun-1-1", "joker-1"],
      tiles,
      "number-first",
    )).toEqual(["sun-1-1", "ocean-1-1", "coral-2-1", "ink-2-1", "joker-1"]);
  });
});

describe("linked rack tiles", () => {
  it("finds the longest contiguous run containing the held tile", () => {
    const rack = ["coral-3-1", "coral-4-1", "coral-5-1", "coral-6-1", "sun-6-1"];
    expect(findLinkedRackTileIds(rack, "coral-4-1", tiles)).toEqual(rack.slice(0, 4));
  });

  it("finds a contiguous same-number group", () => {
    const rack = ["coral-8-1", "sun-8-1", "ocean-8-1", "ink-8-1"];
    expect(findLinkedRackTileIds(rack, "ocean-8-1", tiles)).toEqual(rack);
  });

  it("does not link sorted tiles when gaps make them an invalid run", () => {
    const rack = ["coral-3-1", "coral-5-1", "coral-6-1"];
    expect(findLinkedRackTileIds(rack, "coral-5-1", tiles)).toEqual(["coral-5-1"]);
  });
});

describe("sorted rack meld groups", () => {
  it("separates multiple non-overlapping melds from loose tiles", () => {
    expect(groupSortedRackTileIds([
      "ink-1-1",
      "coral-3-1", "coral-4-1", "coral-5-1",
      "sun-8-1", "ocean-8-1", "ink-8-1",
      "sun-12-1",
    ], tiles)).toEqual([
      { tileIds: ["ink-1-1"], isMeld: false },
      { tileIds: ["coral-3-1", "coral-4-1", "coral-5-1"], isMeld: true },
      { tileIds: ["sun-8-1", "ocean-8-1", "ink-8-1"], isMeld: true },
      { tileIds: ["sun-12-1"], isMeld: false },
    ]);
  });

  it("keeps a long run together instead of splitting it into smaller melds", () => {
    const run = [
      "ocean-3-1", "ocean-4-1", "ocean-5-1",
      "ocean-6-1", "ocean-7-1", "ocean-8-1",
    ];
    expect(groupSortedRackTileIds(run, tiles)).toEqual([{ tileIds: run, isMeld: true }]);
  });

  it("returns one loose group when autosort finds no meld", () => {
    const loose = ["coral-1-1", "sun-4-1", "ocean-9-1"];
    expect(groupSortedRackTileIds(loose, tiles)).toEqual([{ tileIds: loose, isMeld: false }]);
  });
});

describe("meld normalization", () => {
  it("orders runs numerically after melds are merged", () => {
    expect(normalizeMeldTileIds(
      ["ocean-7-1", "ocean-4-1", "ocean-6-1", "ocean-5-1"],
      tiles,
    )).toEqual(["ocean-4-1", "ocean-5-1", "ocean-6-1", "ocean-7-1"]);
  });

  it("orders groups using the standard color order", () => {
    expect(normalizeMeldTileIds(
      ["ink-8-1", "ocean-8-1", "coral-8-1", "sun-8-1"],
      tiles,
    )).toEqual(["coral-8-1", "sun-8-1", "ocean-8-1", "ink-8-1"]);
  });

  it("repairs an unordered run containing a joker", () => {
    expect(normalizeMeldTileIds(
      ["ocean-9-1", "ocean-7-1", "joker-1"],
      tiles,
    )).toEqual(["ocean-7-1", "joker-1", "ocean-9-1"]);
  });

  it("does not change a valid joker position and its represented value", () => {
    expect(normalizeMeldTileIds(
      ["ocean-10-1", "ocean-11-1", "joker-1"],
      tiles,
    )).toEqual(["ocean-10-1", "ocean-11-1", "joker-1"]);
  });
});
