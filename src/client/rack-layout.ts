export const RACK_ROW_COUNT = 2;
export const MIN_RACK_SLOTS_PER_ROW = 7;
export const MANUAL_RACK_SLOTS_PER_ROW = 14;
const MAX_RACK_SLOTS_PER_ROW = 53;

export interface RackLayout {
  slotsPerRow: number;
  /** Slots are stored by column, then row, so adding a column never moves an existing slot. */
  slots: Array<string | null>;
}

export type RackDropSide = "before" | "after";

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

function withCapacity(
  layout: RackLayout,
  tileCount: number,
  minimumSlotsPerRow = MIN_RACK_SLOTS_PER_ROW,
): RackLayout {
  const slotsPerRow = Math.max(
    minimumSlotsPerRow,
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

export function reconcileRackLayout(
  layout: RackLayout,
  tileIds: string[],
  minimumSlotsPerRow = MIN_RACK_SLOTS_PER_ROW,
): RackLayout {
  const wanted = new Set(tileIds);
  const retained = new Set<string>();
  const next = withCapacity(layout, tileIds.length, minimumSlotsPerRow);
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
 * Places one or more tiles at a rack slot. Empty destinations are filled
 * directly. When a drop side is supplied for an occupied destination, the
 * destination tile is pushed away from that side and the other tiles follow.
 *
 * The side is optional for callers that only need the old swap behavior (for
 * example, restoring a persisted layout); interactive occupied-slot drops
 * always provide it.
 */
export function placeRackTilesAtSlot(
  layout: RackLayout,
  tileIds: string[],
  targetSlotIndex: number,
  dropSide?: RackDropSide,
): RackLayout {
  const movingIds = [...new Set(tileIds)];
  if (movingIds.length === 0) return layout;

  const present = new Set(layout.slots.filter((tileId): tileId is string => tileId !== null));
  const addedCount = movingIds.filter((tileId) => !present.has(tileId)).length;
  const next = withCapacity(layout, present.size + addedCount);
  const visualIndices = visualSlotIndices(next);
  const targetVisualIndex = visualIndices.indexOf(targetSlotIndex);
  if (targetVisualIndex < 0) return layout;

  const targetTileId = next.slots[targetSlotIndex];
  const movingSet = new Set(movingIds);
  const sourceIndices = visualIndices.filter((slotIndex) => {
    const tileId = next.slots[slotIndex];
    return typeof tileId === "string" && movingSet.has(tileId);
  });

  // Dropping a rack selection onto any tile in that same selection means the
  // bundle was put back where it came from. Treat the whole gesture as a
  // no-op rather than rotating the selected tiles around the targeted member.
  if (addedCount === 0 && typeof targetTileId === "string" && movingSet.has(targetTileId)) {
    return layout;
  }

  if (typeof targetTileId !== "string") {
    // An empty slot is a direct destination. Reuse the slots vacated by the
    // moving tiles for any additional selected tiles instead of displacing
    // unrelated tiles along the way.
    const destinationIndices = [
      targetSlotIndex,
      ...sourceIndices.filter((slotIndex) => slotIndex !== targetSlotIndex),
      ...visualIndices.filter((slotIndex) => next.slots[slotIndex] === null && !sourceIndices.includes(slotIndex)),
    ];
    sourceIndices.forEach((slotIndex) => { next.slots[slotIndex] = null; });
    movingIds.forEach((tileId, index) => {
      const slotIndex = destinationIndices[index];
      if (slotIndex !== undefined) next.slots[slotIndex] = tileId;
    });
    return next;
  }

  if (dropSide && typeof targetTileId === "string" && !movingIds.includes(targetTileId)) {
    const targetRow = targetSlotIndex % RACK_ROW_COUNT;
    const rowIndices = Array.from(
      { length: next.slotsPerRow },
      (_, columnIndex) => rackSlotIndex(targetRow, columnIndex),
    );
    sourceIndices.forEach((slotIndex) => { next.slots[slotIndex] = null; });
    const targetPosition = rowIndices.findIndex((slotIndex) => next.slots[slotIndex] === targetTileId);
    if (targetPosition < 0) return layout;

    const insertionPosition = targetPosition + (dropSide === "after" ? 1 : 0);
    const firstAvailablePosition = rowIndices.findIndex((slotIndex, position) =>
      position >= insertionPosition + movingIds.length - 1 && next.slots[slotIndex] === null,
    );

    if (firstAvailablePosition >= insertionPosition + movingIds.length - 1) {
      for (let position = firstAvailablePosition; position >= insertionPosition + movingIds.length; position -= 1) {
        const destinationSlot = rowIndices[position];
        const sourceSlot = rowIndices[position - movingIds.length];
        if (destinationSlot !== undefined && sourceSlot !== undefined) {
          next.slots[destinationSlot] = next.slots[sourceSlot] ?? null;
        }
      }
      movingIds.forEach((tileId, index) => {
        const slotIndex = rowIndices[insertionPosition + index];
        if (slotIndex !== undefined) next.slots[slotIndex] = tileId;
      });
      return next;
    }

    // If the push runs into the edge of a row, shift only the necessary
    // suffix and put the pushed-out edge tile into a slot vacated by a moving
    // tile. No other tiles are compacted or reordered.
    const effectiveInsertion = Math.min(
      insertionPosition,
      Math.max(0, rowIndices.length - movingIds.length),
    );
    const overflow = rowIndices
      .slice(Math.max(0, rowIndices.length - movingIds.length))
      .map((slotIndex) => next.slots[slotIndex])
      .filter((tileId): tileId is string => typeof tileId === "string");
    for (let position = rowIndices.length - 1; position >= effectiveInsertion + movingIds.length; position -= 1) {
      const destinationSlot = rowIndices[position];
      const sourceSlot = rowIndices[position - movingIds.length];
      if (destinationSlot !== undefined && sourceSlot !== undefined) {
        next.slots[destinationSlot] = next.slots[sourceSlot] ?? null;
      }
    }
    movingIds.forEach((tileId, index) => {
      const slotIndex = rowIndices[effectiveInsertion + index];
      if (slotIndex !== undefined) next.slots[slotIndex] = tileId;
    });

    const rowSet = new Set(rowIndices);
    const fallbackIndices = [
      ...sourceIndices.filter((slotIndex) => next.slots[slotIndex] === null),
      ...visualIndices.filter((slotIndex) => !rowSet.has(slotIndex) && next.slots[slotIndex] === null),
    ];
    overflow.forEach((tileId, index) => {
      const slotIndex = fallbackIndices[index];
      if (slotIndex !== undefined) next.slots[slotIndex] = tileId;
    });
    return next;
  }

  const destinationIndices = Array.from(
    { length: movingIds.length },
    (_, offset) => visualIndices[(targetVisualIndex + offset) % visualIndices.length]!,
  );
  const destinationSet = new Set(destinationIndices);
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
