export const RACK_ROW_COUNT = 2;
export const MIN_RACK_SLOTS_PER_ROW = 7;
const MAX_RACK_SLOTS_PER_ROW = 53;

export interface RackLayout {
  slotsPerRow: number;
  /** Slots are stored by column, then row, so adding a column never moves an existing slot. */
  slots: Array<string | null>;
}

export function rackSlotIndex(rowIndex: number, columnIndex: number): number {
  return columnIndex * RACK_ROW_COUNT + rowIndex;
}

export function rackSlotRows(layout: RackLayout): Array<Array<string | null>> {
  return Array.from({ length: RACK_ROW_COUNT }, (_, rowIndex) =>
    Array.from(
      { length: layout.slotsPerRow },
      (_, columnIndex) => layout.slots[rackSlotIndex(rowIndex, columnIndex)] ?? null,
    ),
  );
}

export function rackTileIds(layout: RackLayout): string[] {
  return rackSlotRows(layout)
    .flat()
    .filter((tileId): tileId is string => typeof tileId === "string");
}

function visualSlotIndices(layout: RackLayout): number[] {
  return Array.from({ length: RACK_ROW_COUNT }, (_, rowIndex) =>
    Array.from(
      { length: layout.slotsPerRow },
      (_, columnIndex) => rackSlotIndex(rowIndex, columnIndex),
    ),
  ).flat();
}

function withCapacity(layout: RackLayout, tileCount: number): RackLayout {
  const slotsPerRow = Math.max(
    MIN_RACK_SLOTS_PER_ROW,
    layout.slotsPerRow,
    Math.ceil(tileCount / RACK_ROW_COUNT),
  );
  if (slotsPerRow === layout.slotsPerRow) {
    return { ...layout, slots: [...layout.slots] };
  }
  return {
    slotsPerRow,
    slots: [
      ...layout.slots,
      ...Array.from(
        { length: (slotsPerRow - layout.slotsPerRow) * RACK_ROW_COUNT },
        () => null,
      ),
    ],
  };
}

export function createRackLayout(
  tileIds: string[],
  minimumSlotsPerRow = MIN_RACK_SLOTS_PER_ROW,
): RackLayout {
  const slotsPerRow = Math.max(minimumSlotsPerRow, Math.ceil(tileIds.length / RACK_ROW_COUNT));
  const layout: RackLayout = {
    slotsPerRow,
    slots: Array.from({ length: slotsPerRow * RACK_ROW_COUNT }, () => null),
  };
  const firstRowLength = Math.ceil(tileIds.length / RACK_ROW_COUNT);
  tileIds.forEach((tileId, index) => {
    const rowIndex = index < firstRowLength ? 0 : 1;
    const columnIndex = rowIndex === 0 ? index : index - firstRowLength;
    layout.slots[rackSlotIndex(rowIndex, columnIndex)] = tileId;
  });
  return layout;
}

export function reconcileRackLayout(layout: RackLayout, tileIds: string[]): RackLayout {
  const wanted = new Set(tileIds);
  const retained = new Set<string>();
  const next = withCapacity(layout, tileIds.length);
  next.slots = next.slots.map((tileId) => {
    if (tileId === null || !wanted.has(tileId) || retained.has(tileId)) return null;
    retained.add(tileId);
    return tileId;
  });

  const missing = tileIds.filter((tileId) => !retained.has(tileId));
  const emptySlots = visualSlotIndices(next).filter((slotIndex) => next.slots[slotIndex] === null);
  missing.forEach((tileId, index) => {
    const slotIndex = emptySlots[index];
    if (slotIndex !== undefined) next.slots[slotIndex] = tileId;
  });
  return next;
}

export function removeRackTiles(layout: RackLayout, tileIds: Iterable<string>): RackLayout {
  const removed = new Set(tileIds);
  return {
    ...layout,
    slots: layout.slots.map((tileId) => tileId !== null && removed.has(tileId) ? null : tileId),
  };
}

/**
 * Places one or more tiles at a rack slot. Occupied destinations are swapped
 * into the slots vacated by the moving tiles, so no unrelated tile shifts.
 */
export function placeRackTilesAtSlot(
  layout: RackLayout,
  tileIds: string[],
  targetSlotIndex: number,
): RackLayout {
  const movingIds = [...new Set(tileIds)];
  if (movingIds.length === 0) return layout;

  const present = new Set(layout.slots.filter((tileId): tileId is string => tileId !== null));
  const addedCount = movingIds.filter((tileId) => !present.has(tileId)).length;
  const next = withCapacity(layout, present.size + addedCount);
  const visualIndices = visualSlotIndices(next);
  const targetVisualIndex = visualIndices.indexOf(targetSlotIndex);
  if (targetVisualIndex < 0) return layout;

  const destinationIndices = Array.from(
    { length: movingIds.length },
    (_, offset) => visualIndices[(targetVisualIndex + offset) % visualIndices.length]!,
  );
  const destinationSet = new Set(destinationIndices);
  const movingSet = new Set(movingIds);
  const sourceIndices = visualIndices.filter((slotIndex) => {
    const tileId = next.slots[slotIndex];
    return typeof tileId === "string" && movingSet.has(tileId);
  });
  const displacedIds = destinationIndices
    .map((slotIndex) => next.slots[slotIndex])
    .filter((tileId): tileId is string => typeof tileId === "string" && !movingSet.has(tileId));

  sourceIndices.forEach((slotIndex) => { next.slots[slotIndex] = null; });
  destinationIndices.forEach((slotIndex, index) => { next.slots[slotIndex] = movingIds[index]!; });

  const sourceSet = new Set(sourceIndices);
  const fallbackIndices = [
    ...sourceIndices.filter((slotIndex) => !destinationSet.has(slotIndex)),
    ...visualIndices.filter((slotIndex) =>
      !destinationSet.has(slotIndex)
      && !sourceSet.has(slotIndex)
      && next.slots[slotIndex] === null,
    ),
  ];
  displacedIds.forEach((tileId, index) => {
    const slotIndex = fallbackIndices[index];
    if (slotIndex !== undefined) next.slots[slotIndex] = tileId;
  });
  return next;
}

export function parseRackLayout(value: string | null): RackLayout | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<RackLayout>;
    if (
      !Number.isInteger(candidate.slotsPerRow)
      || (candidate.slotsPerRow ?? 0) < 1
      || (candidate.slotsPerRow ?? 0) > MAX_RACK_SLOTS_PER_ROW
    ) return null;
    if (!Array.isArray(candidate.slots)) return null;
    if (candidate.slots.length !== candidate.slotsPerRow! * RACK_ROW_COUNT) return null;
    if (!candidate.slots.every((tileId) => tileId === null || typeof tileId === "string")) return null;
    return { slotsPerRow: candidate.slotsPerRow!, slots: [...candidate.slots] };
  } catch {
    return null;
  }
}
