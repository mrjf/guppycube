export interface FeltLayoutItem {
  id: string;
  orderKey: string;
  tileCount: number;
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

interface SizedItem extends FeltLayoutItem {
  baseWidth: number;
  canonicalIndex: number;
}

interface PackedRow {
  capacity: number;
  items: SizedItem[];
  width: number;
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
  return right.tileCount - left.tileCount
    || left.orderKey.localeCompare(right.orderKey)
    || left.id.localeCompare(right.id);
}

/**
 * Returns the stable packing order. Wider melds come first so best-fit packing
 * cannot strand a long meld in a narrow gap; row-major display order is derived
 * deterministically from the resulting shelves.
 */
export function canonicalFeltItems(items: readonly FeltLayoutItem[]): FeltLayoutItem[] {
  return [...items].sort(compareCanonical);
}

function packRows(
  items: readonly SizedItem[],
  availableWidth: number,
  scale: number,
  restrictedRowCount = 0,
  restrictedWidth = availableWidth,
): PackedRow[] | null {
  const gap = Math.max(2, MELD_GAP * scale);
  const rows: PackedRow[] = Array.from(
    { length: restrictedRowCount },
    () => ({ capacity: restrictedWidth, items: [], width: 0 }),
  );

  for (const item of items) {
    const width = item.baseWidth * scale;
    if (width > availableWidth + 0.01) return null;

    let bestRow: PackedRow | null = null;
    let bestRemaining = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const nextWidth = row.width + (row.items.length > 0 ? gap : 0) + width;
      const remaining = row.capacity - nextWidth;
      if (remaining >= -0.01 && remaining < bestRemaining) {
        bestRow = row;
        bestRemaining = remaining;
      }
    }

    if (bestRow) {
      if (bestRow.items.length > 0) bestRow.width += gap;
      bestRow.items.push(item);
      bestRow.width += width;
    } else {
      rows.push({ capacity: availableWidth, items: [item], width });
    }
  }

  return rows.filter((row) => row.items.length > 0);
}

function layoutAtScale(
  items: readonly SizedItem[],
  availableWidth: number,
  availableHeight: number,
  scale: number,
  obstacle?: FeltLayoutObstacle,
): FeltLayout | null {
  const initialRows = packRows(items, availableWidth, scale);
  if (!initialRows) return null;
  let rows: PackedRow[] = initialRows;

  const rowHeight = MELD_HEIGHT * scale;
  const rowGap = Math.max(2, ROW_GAP * scale);
  const heightFor = (rowCount: number) => rowCount === 0
    ? 0
    : rowCount * rowHeight + (rowCount - 1) * rowGap;
  const centeredRestrictedWidth = obstacle
    ? availableWidth - obstacle.width * 2
    : 0;

  if (obstacle && obstacle.width > 0 && obstacle.height > 0) {
    const restrictedWidth = centeredRestrictedWidth > 0
      ? centeredRestrictedWidth
      : availableWidth - obstacle.width;
    if (restrictedWidth <= 0) return null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const currentHeight = heightFor(rows.length);
      const currentTop = Math.max(0, (availableHeight - currentHeight) / 2);
      const restrictedRowCount = rows.reduce((count, _row, rowIndex) => {
        const y = currentTop + rowIndex * (rowHeight + rowGap);
        return count + (y < obstacle.height && y + rowHeight > 0 ? 1 : 0);
      }, 0);
      const repacked = packRows(items, availableWidth, scale, restrictedRowCount, restrictedWidth);
      if (!repacked) return null;
      const stable = repacked.length === rows.length
        && repacked.every((row, index) => row.capacity === rows[index]?.capacity);
      rows = repacked;
      if (stable) break;
    }
  }

  const contentHeight = heightFor(rows.length);
  if (contentHeight > availableHeight + 0.01) return null;

  const top = Math.max(0, (availableHeight - contentHeight) / 2);
  const placements: FeltPlacement[] = [];

  rows.forEach((row, rowIndex) => {
    const mustAlignLeftOfObstacle = obstacle
      && row.capacity < availableWidth
      && centeredRestrictedWidth <= 0;
    let x = mustAlignLeftOfObstacle
      ? Math.max(0, (row.capacity - row.width) / 2)
      : Math.max(0, (availableWidth - row.width) / 2);
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
  )) return null;

  return {
    scale,
    rowCount: rows.length,
    contentWidth: Math.max(0, ...rows.map((row) => row.width)),
    contentHeight,
    placements,
  };
}

/**
 * Packs the felt without scrollbars. Tile size is preserved whenever the canonical
 * best-fit rows fit; only then does the engine progressively shrink the whole board.
 */
export function createFeltLayout(
  items: readonly FeltLayoutItem[],
  availableWidth: number,
  availableHeight: number,
  topRightObstacle?: FeltLayoutObstacle,
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

  for (let scale = 1; scale >= MIN_SCALE - 0.0001; scale -= SCALE_STEP) {
    const roundedScale = Math.max(MIN_SCALE, Number(scale.toFixed(2)));
    const layout = layoutAtScale(canonical, width, height, roundedScale, topRightObstacle);
    if (layout) return layout;
  }

  // A real felt is never this small, but keeping a deterministic emergency result
  // avoids introducing a scrolling code path during transient zero-ish resizes.
  return layoutAtScale(canonical, width, height, MIN_SCALE, topRightObstacle)
    ?? { scale: MIN_SCALE, rowCount: canonical.length, contentWidth: width, contentHeight: height, placements: [] };
}
