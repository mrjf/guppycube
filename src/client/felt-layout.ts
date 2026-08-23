export interface FeltLayoutItem {
  id: string;
  orderKey: string;
  tileCount: number;
  /** Stable board order, when the caller has one. */
  placementOrder?: number;
}

export interface FeltPlacement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  row: number;
  order: number;
}

export interface FeltLayout {
  scale: number;
  rowCount: number;
  contentWidth: number;
  contentHeight: number;
  placements: FeltPlacement[];
}

export interface FeltLayoutObstacle {
  height: number;
  width: number;
}

const TILE_WIDTH = 51;
const MELD_HEIGHT = 84;
// Keep this in sync with `.meld { gap: 8px }`.  A smaller packing gap lets the
// final tile extend past its reserved rectangle, which can put a real tile
// underneath the draw pile even when the meld rectangle itself is clear.
const TILE_GAP = 8;
const MELD_HORIZONTAL_CHROME = 42;
const MELD_GAP = 12;
const ROW_GAP = 8;
const MIN_SCALE = 0.05;
const SCALE_STEP = 0.01;
const PREFERRED_ROW_COUNT = 4;

interface SizedItem extends FeltLayoutItem {
  baseWidth: number;
  canonicalIndex: number;
}

interface PackedRow {
  capacity: number;
  items: SizedItem[];
  width: number;
}

interface RowBounds {
  minX: number;
  maxX: number;
}

function overlapsTopRightObstacle(
  placement: Pick<FeltPlacement, "x" | "y" | "width" | "height">,
  availableWidth: number,
  obstacle: FeltLayoutObstacle,
): boolean {
  const obstacleLeft = availableWidth - obstacle.width;
  return placement.x < availableWidth
    && placement.x + placement.width > obstacleLeft + 0.01
    && placement.y < obstacle.height
    && placement.y + placement.height > 0;
}

function baseMeldWidth(tileCount: number): number {
  const count = Math.max(1, tileCount);
  return MELD_HORIZONTAL_CHROME + count * TILE_WIDTH + (count - 1) * TILE_GAP;
}

function compareCanonical(left: FeltLayoutItem, right: FeltLayoutItem): number {
  const leftPlacementOrder = left.placementOrder;
  const rightPlacementOrder = right.placementOrder;
  if (leftPlacementOrder !== undefined && rightPlacementOrder !== undefined) {
    return leftPlacementOrder - rightPlacementOrder
      || left.id.localeCompare(right.id);
  }
  return right.tileCount - left.tileCount
    || left.orderKey.localeCompare(right.orderKey)
    || left.id.localeCompare(right.id);
}

/**
 * Returns the stable packing order. The live board supplies its original board
 * order so a meld keeps its identity when its tile count changes. Standalone
 * callers retain the deterministic longest-first fallback.
 */
export function canonicalFeltItems(items: readonly FeltLayoutItem[]): FeltLayoutItem[] {
  return [...items].sort(compareCanonical);
}

function packRows(
  items: readonly SizedItem[],
  availableWidth: number,
  scale: number,
  rowCount: number,
  rowCapacities: readonly number[],
  previousPlacements: ReadonlyMap<string, FeltPlacement> | undefined,
): PackedRow[] | null {
  const gap = Math.max(2, MELD_GAP * scale);
  const rows: PackedRow[] = Array.from(
    { length: rowCount },
    (_, rowIndex) => ({
      capacity: rowCapacities[rowIndex] ?? availableWidth,
      items: [],
      width: 0,
    }),
  );

  for (const [itemIndex, item] of items.entries()) {
    const width = item.baseWidth * scale;
    if (width > availableWidth + 0.01) return null;

    const previousRow = previousPlacements?.get(item.id)?.row;
    const preferredRow = itemIndex % rowCount;
    const candidateRows = [
      ...(previousRow !== undefined && previousRow < rowCount ? [previousRow] : []),
      ...Array.from({ length: rowCount }, (_, offset) => (preferredRow + offset) % rowCount),
    ];

    let placed = false;
    for (const rowIndex of candidateRows) {
      const row = rows[rowIndex];
      if (!row) continue;
      const nextWidth = row.width + (row.items.length > 0 ? gap : 0) + width;
      if (nextWidth <= row.capacity + 0.01) {
        if (row.items.length > 0) row.width += gap;
        row.items.push(item);
        row.width += width;
        placed = true;
        break;
      }
    }

    if (!placed) return null;
  }

  return rows.filter((row) => row.items.length > 0);
}

function maxRowsForHeight(availableHeight: number, rowHeight: number, rowGap: number): number {
  return Math.max(1, Math.floor((availableHeight + rowGap + 0.01) / (rowHeight + rowGap)));
}

function movementCost(
  row: PackedRow,
  left: number,
  scale: number,
  previousPlacements: ReadonlyMap<string, FeltPlacement>,
): { movedTiles: number; distance: number } {
  const gap = Math.max(2, MELD_GAP * scale);
  let movedTiles = 0;
  let distance = 0;
  let x = left;
  for (const item of row.items) {
    const previous = previousPlacements.get(item.id);
    if (previous) {
      const delta = Math.abs(previous.x - x);
      if (delta > 0.5) movedTiles += 1;
      distance += delta;
    }
    x += item.baseWidth * scale + gap;
  }
  return { movedTiles, distance };
}

function rowLeft(
  row: PackedRow,
  rowBounds: RowBounds,
  scale: number,
  previousPlacements: ReadonlyMap<string, FeltPlacement> | undefined,
): number {
  const centeredLeft = (rowBounds.minX + rowBounds.maxX - row.width) / 2;
  if (!previousPlacements) return centeredLeft;

  const previousItems = row.items
    .map((item) => previousPlacements.get(item.id))
    .filter((placement): placement is FeltPlacement => placement !== undefined);
  if (previousItems.length === 0) return centeredLeft;

  const previousLeft = Math.min(...previousItems.map((placement) => placement.x));
  const previousRight = Math.max(...previousItems.map((placement) => placement.x + placement.width));
  const leftAnchored = Math.min(rowBounds.maxX - row.width, Math.max(rowBounds.minX, previousLeft));
  const rightAnchored = Math.min(rowBounds.maxX - row.width, Math.max(rowBounds.minX, previousRight - row.width));
  const previousMap = new Map(previousItems.map((placement) => [placement.id, placement]));
  const leftCost = movementCost(row, leftAnchored, scale, previousMap);
  const rightCost = movementCost(row, rightAnchored, scale, previousMap);

  if (leftCost.movedTiles !== rightCost.movedTiles) {
    return leftCost.movedTiles < rightCost.movedTiles ? leftAnchored : rightAnchored;
  }
  if (leftCost.distance !== rightCost.distance) {
    return leftCost.distance < rightCost.distance ? leftAnchored : rightAnchored;
  }
  return centeredLeft;
}

function layoutAtScale(
  items: readonly SizedItem[],
  availableWidth: number,
  availableHeight: number,
  scale: number,
  obstacle?: FeltLayoutObstacle,
  previousPlacements?: ReadonlyMap<string, FeltPlacement>,
): FeltLayout | null {
  const rowHeight = MELD_HEIGHT * scale;
  const rowGap = Math.max(2, ROW_GAP * scale);
  const heightFor = (rowCount: number) => rowCount === 0
    ? 0
    : rowCount * rowHeight + (rowCount - 1) * rowGap;
  const maxRows = maxRowsForHeight(availableHeight, rowHeight, rowGap);
  const firstRowCount = Math.min(items.length, maxRows, PREFERRED_ROW_COUNT);
  const previousRowMap = previousPlacements
    ? new Map([...previousPlacements].map(([id, placement]) => [id, placement]))
    : undefined;

  for (let rowCount = firstRowCount; rowCount <= Math.min(items.length, maxRows); rowCount += 1) {
    const contentHeight = heightFor(rowCount);
    const top = Math.max(0, (availableHeight - contentHeight) / 2);
    const centeredRestrictedWidth = obstacle
      ? availableWidth - obstacle.width * 2
      : 0;
    const restrictedWidth = centeredRestrictedWidth > 0
      ? centeredRestrictedWidth
      : obstacle
        ? availableWidth - obstacle.width
        : availableWidth;
    if (restrictedWidth <= 0) continue;

    const rowCapacities = Array.from({ length: rowCount }, (_, rowIndex) => {
      const y = top + rowIndex * (rowHeight + rowGap);
      return obstacle && y < obstacle.height && y + rowHeight > 0
        ? restrictedWidth
        : availableWidth;
    });
    const rows = packRows(items, availableWidth, scale, rowCount, rowCapacities, previousRowMap);
    if (!rows) continue;

    const placements: FeltPlacement[] = [];
    rows.forEach((row, rowIndex) => {
      const isLeftAlignedObstacleRow = obstacle
        && row.capacity < availableWidth
        && centeredRestrictedWidth <= 0;
      const rowBounds: RowBounds = isLeftAlignedObstacleRow
        ? { minX: 0, maxX: row.capacity }
        : centeredRestrictedWidth > 0 && row.capacity < availableWidth
          ? {
              minX: (availableWidth - row.capacity) / 2,
              maxX: (availableWidth + row.capacity) / 2,
            }
          : { minX: 0, maxX: availableWidth };
      let x = rowLeft(row, rowBounds, scale, previousRowMap);
      const y = top + rowIndex * (rowHeight + rowGap);
      row.items.forEach((item) => {
        const width = item.baseWidth * scale;
        placements.push({
          id: item.id,
          x,
          y,
          width,
          height: rowHeight,
          row: rowIndex,
          order: item.canonicalIndex,
        });
        x += width + Math.max(2, MELD_GAP * scale);
      });
    });

    placements.sort((left, right) => left.row - right.row || left.x - right.x || left.order - right.order);
    placements.forEach((placement, order) => { placement.order = order; });

    // This is a final safety check, rather than relying only on row capacity:
    // a scale is accepted only if every rendered meld rectangle is disjoint from
    // the draw-pile footprint.
    if (obstacle && placements.some((placement) =>
      overlapsTopRightObstacle(placement, availableWidth, obstacle)
    )) continue;

    return {
      scale,
      rowCount: rows.length,
      contentWidth: Math.max(0, ...rows.map((row) => row.width)),
      contentHeight,
      placements,
    };
  }

  return null;
}

/**
 * Packs the felt without scrollbars. Full-size melds are spread through four
 * rows before a second meld is added to a row; only then does the engine
 * progressively shrink the whole board.
 */
export function createFeltLayout(
  items: readonly FeltLayoutItem[],
  availableWidth: number,
  availableHeight: number,
  topRightObstacle?: FeltLayoutObstacle,
  previousLayout?: FeltLayout,
): FeltLayout {
  const width = Math.max(0, availableWidth);
  const height = Math.max(0, availableHeight);
  const canonical = canonicalFeltItems(items).map((item, canonicalIndex) => ({
    ...item,
    baseWidth: baseMeldWidth(item.tileCount),
    canonicalIndex,
  }));

  if (canonical.length === 0 || width === 0 || height === 0) {
    return { scale: 1, rowCount: 0, contentWidth: 0, contentHeight: 0, placements: [] };
  }

  const previousPlacements = previousLayout
    ? new Map(previousLayout.placements.map((placement) => [placement.id, placement]))
    : undefined;

  for (let scale = 1; scale >= MIN_SCALE - 0.0001; scale -= SCALE_STEP) {
    const roundedScale = Math.max(MIN_SCALE, Number(scale.toFixed(2)));
    const scaleMatchesPrevious = previousLayout
      && Math.abs(previousLayout.scale - roundedScale) < 0.005;
    const layout = layoutAtScale(
      canonical,
      width,
      height,
      roundedScale,
      topRightObstacle,
      scaleMatchesPrevious ? previousPlacements : undefined,
    );
    if (layout) return layout;
  }

  // A real felt is never this small, but keeping a deterministic emergency result
  // avoids introducing a scrolling code path during transient zero-ish resizes.
  const scaleMatchesPrevious = previousLayout
    && Math.abs(previousLayout.scale - MIN_SCALE) < 0.005;
  return layoutAtScale(
    canonical,
    width,
    height,
    MIN_SCALE,
    topRightObstacle,
    scaleMatchesPrevious ? previousPlacements : undefined,
  )
    ?? { scale: MIN_SCALE, rowCount: canonical.length, contentWidth: width, contentHeight: height, placements: [] };
}
