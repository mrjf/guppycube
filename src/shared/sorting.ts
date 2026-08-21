import { validateMeld } from "./rules";
import type { Tile, TileColor } from "./types";
import { TILE_COLORS } from "./types";

export type TileSortMode = "color-first" | "number-first";

export interface RackTileGroup {
  tileIds: string[];
  isMeld: boolean;
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

interface MeldRange {
  start: number;
  end: number;
}

function coveredTileCount(ranges: MeldRange[]): number {
  return ranges.reduce((total, range) => total + range.end - range.start, 0);
}

function preferMeldRanges(candidate: MeldRange[], current: MeldRange[]): boolean {
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
 * Marks the best set of non-overlapping melds that are already contiguous in
 * an auto-sorted rack. Loose tiles stay in their existing order, while melds
 * become distinct groups that the rack can separate visually.
 */
export function groupSortedRackTileIds(
  tileIds: string[],
  tiles: Record<string, Tile>,
): RackTileGroup[] {
  const bestFrom = new Map<number, MeldRange[]>();

  function findBestFrom(start: number): MeldRange[] {
    if (start >= tileIds.length) return [];
    const cached = bestFrom.get(start);
    if (cached) return cached;

    let best = findBestFrom(start + 1);
    for (let end = start + 3; end <= tileIds.length; end += 1) {
      if (!validateMeld(tileIds.slice(start, end), tiles).valid) continue;
      const candidate = [{ start, end }, ...findBestFrom(end)];
      if (preferMeldRanges(candidate, best)) best = candidate;
    }
    bestFrom.set(start, best);
    return best;
  }

  const ranges = findBestFrom(0);
  const groups: RackTileGroup[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (cursor < range.start) {
      groups.push({ tileIds: tileIds.slice(cursor, range.start), isMeld: false });
    }
    groups.push({ tileIds: tileIds.slice(range.start, range.end), isMeld: true });
    cursor = range.end;
  }
  if (cursor < tileIds.length) groups.push({ tileIds: tileIds.slice(cursor), isMeld: false });
  return groups;
}

/**
 * Finds the longest valid meld that is already contiguous in a sorted rack and
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
      if (validateMeld(candidate, tiles).valid) linked = candidate;
    }
  }
  return linked;
}

function groupOrder(tileIds: string[], tiles: Record<string, Tile>): string[] | null {
  if (tileIds.length < 3 || tileIds.length > 4) return null;
  const numberedIds = tileIds.filter((id) => !tiles[id]?.joker);
  const jokerIds = tileIds.filter((id) => tiles[id]?.joker).sort();
  const numbered = numberedIds.map((id) => tiles[id]).filter((tile): tile is Tile => Boolean(tile));
  const value = numbered[0]?.value;
  if (numbered.length === 0 || value === null || value === undefined) return null;
  if (numbered.some((tile) => tile.value !== value)) return null;

  const usedColors = numbered.map((tile) => tile.color);
  if (usedColors.some((color) => !color) || new Set(usedColors).size !== usedColors.length) return null;

  const availableColors = TILE_COLORS.filter((color) => !usedColors.includes(color));
  if (availableColors.length < jokerIds.length) return null;
  const assignedJokers = new Map(jokerIds.map((id, index) => [id, availableColors[index]]));

  return [...tileIds].sort((leftId, rightId) => {
    const leftColor = tiles[leftId]?.color ?? assignedJokers.get(leftId);
    const rightColor = tiles[rightId]?.color ?? assignedJokers.get(rightId);
    const leftRank = leftColor ? (COLOR_ORDER.get(leftColor) ?? TILE_COLORS.length) : TILE_COLORS.length;
    const rightRank = rightColor ? (COLOR_ORDER.get(rightColor) ?? TILE_COLORS.length) : TILE_COLORS.length;
    return leftRank - rightRank || leftId.localeCompare(rightId);
  });
}

function runOrder(tileIds: string[], tiles: Record<string, Tile>): string[] | null {
  if (tileIds.length < 3 || tileIds.length > 13) return null;
  const numberedIds = tileIds.filter((id) => !tiles[id]?.joker);
  const jokerIds = tileIds.filter((id) => tiles[id]?.joker).sort();
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

  for (let start = 1; start <= 14 - tileIds.length; start += 1) {
    const end = start + tileIds.length - 1;
    if ([...idByValue.keys()].some((value) => value < start || value > end)) continue;
    const missingValues = Array.from(
      { length: tileIds.length },
      (_, index) => start + index,
    ).filter((value) => !idByValue.has(value));
    if (missingValues.length !== jokerIds.length) continue;

    let jokerIndex = 0;
    return Array.from({ length: tileIds.length }, (_, index) => {
      const value = start + index;
      const numberedId = idByValue.get(value);
      if (numberedId) return numberedId;
      const jokerId = jokerIds[jokerIndex];
      jokerIndex += 1;
      return jokerId!;
    });
  }
  return null;
}

/**
 * Keeps every meld predictable after a move. Valid runs retain their current
 * joker positions; unordered runs are repaired into ascending order and groups
 * use the standard color order.
 */
export function normalizeMeldTileIds(
  tileIds: string[],
  tiles: Record<string, Tile>,
): string[] {
  const current = validateMeld(tileIds, tiles);
  if (current.valid && current.kind === "run") return [...tileIds];

  const asGroup = groupOrder(tileIds, tiles);
  if (asGroup) return asGroup;
  const asRun = runOrder(tileIds, tiles);
  if (asRun) return asRun;

  const numbered = tileIds.map((id) => tiles[id]).filter((tile): tile is Tile => Boolean(tile && !tile.joker));
  const sameValue = numbered.length > 0 && numbered.every((tile) => tile.value === numbered[0]?.value);
  return sortTileIds(tileIds, tiles, sameValue ? "color-first" : "number-first");
}
