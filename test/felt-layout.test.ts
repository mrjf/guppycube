import { describe, expect, it } from "vitest";
import { canonicalFeltItems, createFeltLayout, type FeltLayoutItem } from "../src/client/felt-layout";

function meld(id: string, tileCount: number, orderKey = id): FeltLayoutItem {
  return { id, tileCount, orderKey };
}

function expectContained(layout: ReturnType<typeof createFeltLayout>, width: number, height: number): void {
  expect(layout.contentWidth).toBeLessThanOrEqual(width + 0.01);
  expect(layout.contentHeight).toBeLessThanOrEqual(height + 0.01);
  for (const placement of layout.placements) {
    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.y).toBeGreaterThanOrEqual(0);
    expect(placement.x + placement.width).toBeLessThanOrEqual(width + 0.01);
    expect(placement.y + placement.height).toBeLessThanOrEqual(height + 0.01);
  }
}

function expectClearOfTopRightObstacle(
  layout: ReturnType<typeof createFeltLayout>,
  width: number,
  obstacle: { width: number; height: number },
): void {
  const obstacleLeft = width - obstacle.width;
  for (const placement of layout.placements) {
    const overlaps = placement.x < width
      && placement.x + placement.width > obstacleLeft + 0.01
      && placement.y < obstacle.height
      && placement.y + placement.height > 0;
    expect(overlaps, `${placement.id} should clear the draw-pile footprint`).toBe(false);
  }
}

describe("canonicalFeltItems", () => {
  it("uses one deterministic longest-first order regardless of server order", () => {
    const items = [meld("short-z", 3, "z"), meld("long-b", 5, "b"), meld("short-a", 3, "a")];
    expect(canonicalFeltItems(items).map(({ id }) => id)).toEqual(["long-b", "short-a", "short-z"]);
    expect(canonicalFeltItems([...items].reverse()).map(({ id }) => id)).toEqual(["long-b", "short-a", "short-z"]);

    const forwardLayout = createFeltLayout(items, 360, 300);
    const reverseLayout = createFeltLayout([...items].reverse(), 360, 300);
    expect(reverseLayout.placements.map(({ id }) => id)).toEqual(forwardLayout.placements.map(({ id }) => id));
  });
});

describe("createFeltLayout", () => {
  it("best-fits complementary meld widths instead of stranding usable row space", () => {
    const layout = createFeltLayout([
      meld("five", 5),
      meld("four", 4),
      meld("three", 3),
      meld("two", 2),
      meld("one", 1),
    ], 422, 300);

    expect(layout.scale).toBe(1);
    expect(layout.rowCount).toBe(3);
    expect(layout.placements.filter(({ row }) => row === 0).map(({ id }) => id)).toEqual(["five"]);
    expect(layout.placements.filter(({ row }) => row === 1).map(({ id }) => id)).toEqual(["four", "one"]);
    expect(layout.placements.filter(({ row }) => row === 2).map(({ id }) => id)).toEqual(["three", "two"]);
    expectContained(layout, 422, 300);
  });

  it("uses the full width before adding rows", () => {
    const layout = createFeltLayout(
      Array.from({ length: 12 }, (_, index) => meld(`meld-${index.toString().padStart(2, "0")}`, 1)),
      1_250,
      300,
    );

    expect(layout.scale).toBe(1);
    expect(layout.rowCount).toBe(1);
    expect(layout.placements).toHaveLength(12);
    expectContained(layout, 1_250, 300);
  });

  it("shrinks only when full-size rows cannot fit the felt", () => {
    const items = Array.from({ length: 24 }, (_, index) => meld(`meld-${index}`, 3));
    const roomy = createFeltLayout(items, 1_280, 900);
    const constrained = createFeltLayout(items, 390, 220);

    expect(roomy.scale).toBe(1);
    expect(constrained.scale).toBeLessThan(1);
    expect(constrained.placements).toHaveLength(items.length);
    expectContained(constrained, 390, 220);
  });

  it("contains the legal worst case without creating a scrolling fallback", () => {
    const worstCase = Array.from({ length: 35 }, (_, index) => meld(`meld-${index}`, 3));
    const layout = createFeltLayout(worstCase, 320, 160);

    expect(layout.scale).toBeGreaterThanOrEqual(0.05);
    expect(layout.placements).toHaveLength(worstCase.length);
    expectContained(layout, 320, 160);
  });

  it("also contains a defensive all-singleton draft", () => {
    const defensiveWorstCase = Array.from({ length: 106 }, (_, index) => meld(`tile-${index}`, 1));
    const layout = createFeltLayout(defensiveWorstCase, 320, 160);

    expect(layout.placements).toHaveLength(defensiveWorstCase.length);
    expectContained(layout, 320, 160);
  });

  it("packs around a top-right draw pile without wasting the width below it", () => {
    const items = [
      meld("wide", 3),
      ...Array.from({ length: 10 }, (_, index) => meld(`single-${index}`, 1)),
    ];
    const width = 378;
    const height = 171;
    const obstacle = { width: 70, height: 58 };
    const layout = createFeltLayout(items, width, height, obstacle);

    expect(layout.placements).toHaveLength(items.length);
    expectContained(layout, width, height);
    expect(layout.placements.some((placement) => placement.y >= obstacle.height)).toBe(true);
    expectClearOfTopRightObstacle(layout, width, obstacle);
  });

  it("keeps rows centered when they can clear a top-right draw pile", () => {
    const width = 1_256;
    const layout = createFeltLayout(
      Array.from({ length: 14 }, (_, index) => meld(`single-${index}`, 1)),
      width,
      241,
      { width: 95, height: 53 },
    );
    const left = Math.min(...layout.placements.map((placement) => placement.x));
    const right = Math.max(...layout.placements.map((placement) => placement.x + placement.width));

    expect(layout.scale).toBe(1);
    expect((left + right) / 2).toBeCloseTo(width / 2, 5);
    expectClearOfTopRightObstacle(layout, width, { width: 95, height: 53 });
  });
});
