import { describe, expect, it } from "vitest";
import {
  createRackLayout,
  MANUAL_RACK_SLOTS_PER_ROW,
  parseRackLayout,
  placeRackTilesAtSlot,
  rackSlotIndex,
  rackSlotRows,
  rackTileIds,
  reconcileRackLayout,
  removeRackTiles,
} from "../src/client/rack-layout";

describe("rack layout", () => {
  it("creates two equal rows of fixed slots", () => {
    const layout = createRackLayout(Array.from({ length: 14 }, (_, index) => `tile-${index + 1}`));

    expect(layout.slotsPerRow).toBe(7);
    expect(rackSlotRows(layout)).toEqual([
      Array.from({ length: 7 }, (_, index) => `tile-${index + 1}`),
      Array.from({ length: 7 }, (_, index) => `tile-${index + 8}`),
    ]);
  });

  it("keeps holes when tiles leave and fills them when they return", () => {
    const initial = createRackLayout(["a", "b", "c", "d"]);
    const withoutB = removeRackTiles(initial, ["b"]);
    const reconciled = reconcileRackLayout(withoutB, ["a", "b", "c", "d"]);

    expect(reconciled.slots).toEqual(initial.slots);
    expect(rackTileIds(reconciled)).toEqual(["a", "b", "c", "d"]);
  });

  it("swaps a dragged tile with an occupied slot without shifting other tiles", () => {
    const initial = createRackLayout(["a", "b", "c", "d"]);
    const moved = placeRackTilesAtSlot(initial, ["a"], rackSlotIndex(1, 0));

    expect(rackSlotRows(moved)[0]!.slice(0, 2)).toEqual(["c", "b"]);
    expect(rackSlotRows(moved)[1]!.slice(0, 2)).toEqual(["a", "d"]);
  });

  it("pushes the occupied row to the right when dropped on the left side", () => {
    const initial = createRackLayout(["a", "b", "c", "d"]);
    const moved = placeRackTilesAtSlot(initial, ["d"], rackSlotIndex(0, 1), "before");

    expect(rackSlotRows(moved)[0]!.slice(0, 3)).toEqual(["a", "d", "b"]);
    expect(rackSlotRows(moved)[1]![0]).toBe("c");
  });

  it("pushes the occupied row to the right after a right-side drop", () => {
    const initial = createRackLayout(["a", "b", "c", "d"]);
    const moved = placeRackTilesAtSlot(initial, ["d"], rackSlotIndex(0, 1), "after");

    expect(rackSlotRows(moved)[0]!.slice(0, 3)).toEqual(["a", "b", "d"]);
    expect(rackSlotRows(moved)[1]![0]).toBe("c");
  });

  it("places a tile into any empty slot", () => {
    const initial = removeRackTiles(createRackLayout(["a", "b", "c"]), ["b"]);
    const target = rackSlotIndex(1, 6);
    const moved = placeRackTilesAtSlot(initial, ["b"], target);

    expect(moved.slots[target]).toBe("b");
    expect(rackTileIds(moved).sort()).toEqual(["a", "b", "c"]);
  });

  it("moves into an empty slot without displacing unrelated tiles", () => {
    const initial = createRackLayout(["a", "b", "c", "d"]);
    const moved = placeRackTilesAtSlot(initial, ["a"], rackSlotIndex(1, 6));

    expect(rackSlotRows(moved)[0]!.slice(0, 2)).toEqual([null, "b"]);
    expect(rackSlotRows(moved)[1]!.slice(0, 2)).toEqual(["c", "d"]);
    expect(moved.slots[rackSlotIndex(1, 6)]).toBe("a");
  });

  it("pushes only the occupied suffix when a full row needs room", () => {
    const initial = createRackLayout(Array.from({ length: 14 }, (_, index) => `tile-${index + 1}`));
    const moved = placeRackTilesAtSlot(initial, ["tile-8"], rackSlotIndex(0, 3), "before");

    expect(rackSlotRows(moved)[0]).toEqual([
      "tile-1", "tile-2", "tile-3", "tile-8", "tile-4", "tile-5", "tile-6",
    ]);
    expect(rackSlotRows(moved)[1]![0]).toBe("tile-7");
    expect(rackSlotRows(moved)[1]!.slice(1)).toEqual([
      "tile-9", "tile-10", "tile-11", "tile-12", "tile-13", "tile-14",
    ]);
  });

  it("moves multiple tiles without losing displaced tiles", () => {
    const initial = createRackLayout(["a", "b", "c", "d", "e", "f"]);
    const moved = placeRackTilesAtSlot(initial, ["a", "b"], rackSlotIndex(1, 0));

    expect(rackTileIds(moved).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(rackSlotRows(moved)[1]!.slice(0, 2)).toEqual(["a", "b"]);
  });

  it("adds columns without changing existing slot coordinates", () => {
    const initial = placeRackTilesAtSlot(createRackLayout(["a"]), ["a"], rackSlotIndex(1, 6));
    const expanded = reconcileRackLayout(initial, Array.from({ length: 15 }, (_, index) => index === 0 ? "a" : `tile-${index}`));

    expect(expanded.slotsPerRow).toBe(8);
    expect(expanded.slots[rackSlotIndex(1, 6)]).toBe("a");
  });

  it("expands manual racks with landing spots across both rows", () => {
    const compact = createRackLayout(Array.from({ length: 14 }, (_, index) => `tile-${index + 1}`));
    const manual = reconcileRackLayout(
      compact,
      rackTileIds(compact),
      MANUAL_RACK_SLOTS_PER_ROW,
    );

    expect(manual.slotsPerRow).toBe(14);
    expect(rackSlotRows(manual).every((row) => row.length === 14)).toBe(true);
    expect(rackTileIds(manual)).toEqual(rackTileIds(compact));
    expect(manual.slots[rackSlotIndex(1, 13)]).toBeNull();
  });

  it("only accepts valid persisted layouts", () => {
    const layout = createRackLayout(["a", "b"]);
    expect(parseRackLayout(JSON.stringify(layout))).toEqual(layout);
    expect(parseRackLayout('{"slotsPerRow":7,"slots":["a"]}')).toBeNull();
    expect(parseRackLayout('{"slotsPerRow":1000000,"slots":[]}')).toBeNull();
    expect(parseRackLayout("not json")).toBeNull();
  });
});
