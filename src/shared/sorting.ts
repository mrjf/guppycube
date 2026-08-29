import { validateSet } from "./rules";
import type { Tile, TileColor } from "./types";
import { TILE_COLORS, TILE_NUMBER_MAX, TILE_NUMBER_MIN } from "./types";

export type TileSortMode = "color-first" | "number-first";

export interface RackTileGroup {
  tileIds: string[];
  isSet: boolean;
}

const COLOR_ORDER = new Map<TileColor, number>(
  TILE_COLORS.map((color, index) => [color, index]),
);

function colorRank(tile: Tile | undefined): number {
  if (!tile?.color) return TILE_COLORS.length;
  return COLOR_ORDER.get(tile.color) ?? TILE_COLORS.length;
}

function numberRank(tile: Tile | undefined): number {
  return tile?.value ?? 14;
}

export function compareTileIds(
  leftId: string,
  rightId: string,
  tiles: Record<string, Tile>,
  mode: TileSortMode,
): number {
  const left = tiles[leftId];
  const right = tiles[rightId];
  const primary = mode === "color-first"
    ? colorRank(left) - colorRank(right)
    : numberRank(left) - numberRank(right);
  if (primary !== 0) return primary;

  const secondary = mode === "color-first"
    ? numberRank(left) - numberRank(right)
    : colorRank(left) - colorRank(right);
  return secondary || leftId.localeCompare(rightId);
}

export function sortTileIds(
  tileIds: string[],
  tiles: Record<string, Tile>,
  mode: TileSortMode,
): string[] {
  return [...tileIds].sort((left, right) => compareTileIds(left, right, tiles, mode));
}

interface SetRange {
  start: number;
  end: number;
}

function coveredTileCount(ranges: SetRange[]): number {
  return ranges.reduce((total, range) => total + range.end - range.start, 0);
}

function preferSetRanges(candidate: SetRange[], current: SetRange[]): boolean {
  const coveredDifference = coveredTileCount(candidate) - coveredTileCount(current);
  if (coveredDifference !== 0) return coveredDifference > 0;

  // Keep a long run together instead of presenting it as multiple smaller runs.
  if (candidate.length !== current.length) return candidate.length < current.length;

  for (let index = 0; index < candidate.length; index += 1) {
    const candidateRange = candidate[index]!;
    const currentRange = current[index]!;
    if (candidateRange.start !== currentRange.start) return candidateRange.start < currentRange.start;
    if (candidateRange.end !== currentRange.end) return candidateRange.end > currentRange.end;
  }
  return false;
}

/**
 * Marks the best set of non-overlapping sets that are already contiguous in
 * an auto-sorted rack. Loose tiles stay in their existing order, while sets
 * become distinct groups that the rack can separate visually.
 */
export function groupSortedRackTileIds(
  tileIds: string[],
  tiles: Record<string, Tile>,
): RackTileGroup[] {
  const bestFrom = new Map<number, SetRange[]>();

  function findBestFrom(start: number): SetRange[] {
    if (start >= tileIds.length) return [];
    const cached = bestFrom.get(start);
    if (cached) return cached;

    let best = findBestFrom(start + 1);
    for (let end = start + 3; end <= tileIds.length; end += 1) {
      if (!validateSet(tileIds.slice(start, end), tiles).valid) continue;
      const candidate = [{ start, end }, ...findBestFrom(end)];
      if (preferSetRanges(candidate, best)) best = candidate;
    }
    bestFrom.set(start, best);
    return best;
  }

  const ranges = findBestFrom(0);
  const groups: RackTileGroup[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) {
      groups.push({ tileIds: tileIds.slice(cursor, range.start), isSet: false });
    }
    groups.push({ tileIds: tileIds.slice(range.start, range.end), isSet: true });
    cursor = range.end;
  }
  if (cursor < tileIds.length) groups.push({ tileIds: tileIds.slice(cursor), isSet: false });
  return groups;
}

/**
 * Finds the longest valid set that is already contiguous in a sorted rack and
 * contains the held tile. Returning the held tile by itself keeps an ordinary
 * long-press useful even when there is no linked run or group beside it.
 */
export function findLinkedRackTileIds(
  tileIds: string[],
  heldTileId: string,
  tiles: Record<string, Tile>,
): string[] {
  const heldIndex = tileIds.indexOf(heldTileId);
  if (heldIndex < 0) return [];

  let linked = [heldTileId];
  for (let start = 0; start <= heldIndex; start += 1) {
    for (let end = heldIndex + 1; end <= tileIds.length; end += 1) {
      const candidate = tileIds.slice(start, end);
      if (candidate.length <= linked.length) continue;
      if (validateSet(candidate, tiles).valid) linked = candidate;
    }
  }
  return linked;
}

function groupOrder(tileIds: string[], tiles: Record<string, Tile>): string[] | null {
  if (tileIds.length < 3 || tileIds.length > 4) return null;
  const numberedIds = tileIds.filter((id) => !tiles[id]?.wilcard);
  const wilcardIds = tileIds.filter((id) => tiles[id]?.wilcard).sort();
  const numbered = numberedIds.map((id) => tiles[id]).filter((tile): tile is Tile => Boolean(tile));
  const value = numbered[0]?.value;
  if (numbered.length === 0 || value === null || value === undefined) return null;
  if (numbered.some((tile) => tile.value !== value)) return null;

  const usedColors = numbered.map((tile) => tile.color);
  if (usedColors.some((color) => !color) || new Set(usedColors).size !== usedColors.length) return null;

  const availableColors = TILE_COLORS.filter((color) => !usedColors.includes(color));
  if (availableColors.length < wilcardIds.length) return null;
  const assignedWilcards = new Map(wilcardIds.map((id, index) => [id, availableColors[index]]));

  return [...tileIds].sort((leftId, rightId) => {
    const leftColor = tiles[leftId]?.color ?? assignedWilcards.get(leftId);
    const rightColor = tiles[rightId]?.color ?? assignedWilcards.get(rightId);
    const leftRank = leftColor ? (COLOR_ORDER.get(leftColor) ?? TILE_COLORS.length) : TILE_COLORS.length;
    const rightRank = rightColor ? (COLOR_ORDER.get(rightColor) ?? TILE_COLORS.length) : TILE_COLORS.length;
    return leftRank - rightRank || leftId.localeCompare(rightId);
  });
}

function runOrder(tileIds: string[], tiles: Record<string, Tile>): string[] | null {
  if (tileIds.length < 3 || tileIds.length > TILE_NUMBER_MAX) return null;
  const numberedIds = tileIds.filter((id) => !tiles[id]?.wilcard);
  const wilcardIds = tileIds.filter((id) => tiles[id]?.wilcard).sort();
  if (numberedIds.length === 0) return null;

  const colors = numberedIds.map((id) => tiles[id]?.color);
  const color = colors[0];
  if (!color || colors.some((candidate) => candidate !== color)) return null;

  const idByValue = new Map<number, string>();
  for (const id of numberedIds) {
    const value = tiles[id]?.value;
    if (value === null || value === undefined || idByValue.has(value)) return null;
    idByValue.set(value, id);
  }

  for (let start = TILE_NUMBER_MIN; start <= TILE_NUMBER_MAX + 1 - tileIds.length; start += 1) {
    const end = start + tileIds.length - 1;
    if ([...idByValue.keys()].some((value) => value < start || value > end)) continue;
    const missingValues = Array.from(
      { length: tileIds.length },
      (_, index) => start + index,
    ).filter((value) => !idByValue.has(value));
    if (missingValues.length !== wilcardIds.length) continue;

    let wilcardIndex = 0;
    return Array.from({ length: tileIds.length }, (_, index) => {
      const value = start + index;
      const numberedId = idByValue.get(value);
      if (numberedId) return numberedId;
      const wilcardId = wilcardIds[wilcardIndex];
      wilcardIndex += 1;
      return wilcardId!;
    });
  }
  return null;
}

/**
 * Keeps every set predictable after a move. Valid runs retain their current
 * wilcard positions; unordered runs are repaired into ascending order and groups
 * use the standard color order.
 */
export function normalizeSetTileIds(
  tileIds: string[],
  tiles: Record<string, Tile>,
): string[] {
  const current = validateSet(tileIds, tiles);
  if (current.valid && current.kind === "run") return [...tileIds];

  const asGroup = groupOrder(tileIds, tiles);
  if (asGroup) return asGroup;
  const asRun = runOrder(tileIds, tiles);
  if (asRun) return asRun;

  const numbered = tileIds.map((id) => tiles[id]).filter((tile): tile is Tile => Boolean(tile && !tile.wilcard));
  const sameValue = numbered.length > 0 && numbered.every((tile) => tile.value === numbered[0]?.value);
  return sortTileIds(tileIds, tiles, sameValue ? "color-first" : "number-first");
}
