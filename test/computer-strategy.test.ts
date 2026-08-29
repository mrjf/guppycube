import { describe, expect, it } from "vitest";
import { createTileSet } from "../src/shared/rules";
import { basicComputerStrategy } from "../src/server/computer-strategies/basic";

const tiles = createTileSet();

describe("basic computer strategy", () => {
  it("opens with a simple rack-only set worth at least 30 points", () => {
    const action = basicComputerStrategy.chooseTurn({
      version: 1,
      board: [],
      rack: ["coral-10-1", "sun-10-1", "ocean-10-1", "coral-2-1"],
      opened: false,
      tiles,
    });
    expect(action).toEqual({
      type: "commit",
      board: [{
        id: "computer-2",
        tileIds: ["coral-10-1", "sun-10-1", "ocean-10-1"],
      }],
    });
  });

  it("draws when its only set cannot meet the opening minimum", () => {
    expect(basicComputerStrategy.chooseTurn({
      version: 1,
      board: [],
      rack: ["coral-5-1", "sun-5-1", "ocean-5-1"],
      opened: false,
      tiles,
    })).toEqual({ type: "draw" });
  });

  it("plays a lower-value set after it has opened", () => {
    expect(basicComputerStrategy.chooseTurn({
      version: 4,
      board: [],
      rack: ["coral-3-1", "coral-4-1", "coral-5-1"],
      opened: true,
      tiles,
    })).toMatchObject({ type: "commit" });
  });
});
