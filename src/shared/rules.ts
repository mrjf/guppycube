import type { Meld, Tile, TileColor } from "./types";
import { TILE_COLORS } from "./types";

export const INITIAL_RACK_SIZE = 14;
export const INITIAL_MELD_MINIMUM = 30;
export const JOKER_PENALTY = 30;
export const REALTIME_TURN_MS = 2 * 60 * 1000;
export const CORRESPONDENCE_TURN_MS = 72 * 60 * 60 * 1000;

export type MeldKind = "group" | "run";

export interface MeldValidation {
  valid: boolean;
  kind: MeldKind | null;
  points: number;
  reason: string | null;
}

export interface TurnValidation {
  valid: boolean;
  reason: string | null;
  playedTileIds: string[];
  openingPoints: number;
}

export interface JokerAssignment {
  value: number;
  color: TileColor | null;
  possibleColors: TileColor[];
}

export interface LegalMoveParams {
  board: Meld[];
  rack: string[];
  opened: boolean;
  tiles: Record<string, Tile>;
}

interface MeldCandidate {
  tileIds: string[];
  points: number;
  mask: bigint;
  tableMask: bigint;
  rackMask: bigint;
}

interface MeldCollectionOptions {
  mustIncludeOneOf?: Set<string>;
  stopAfterFirst?: boolean;
}

export function createTileSet(): Record<string, Tile> {
  const tiles: Record<string, Tile> = {};

  for (const color of TILE_COLORS) {
    for (let copy = 1; copy <= 2; copy += 1) {
      for (let value = 1; value <= 13; value += 1) {
        const id = `${color}-${value}-${copy}`;
        tiles[id] = { id, color, value, joker: false };
      }
    }
  }

  tiles["joker-1"] = { id: "joker-1", color: null, value: null, joker: true };
  tiles["joker-2"] = { id: "joker-2", color: null, value: null, joker: true };
  return tiles;
}

function invalid(reason: string): MeldValidation {
  return { valid: false, kind: null, points: 0, reason };
}

function validateGroup(tiles: Tile[]): MeldValidation {
  if (tiles.length < 3 || tiles.length > 4) {
    return invalid("A group must contain three or four tiles.");
  }

  const numbered = tiles.filter((tile) => !tile.joker);
  if (numbered.length === 0) return invalid("A meld needs at least one numbered tile.");

  const value = numbered[0]?.value;
  if (value === null || value === undefined) return invalid("This group has no number.");
  if (numbered.some((tile) => tile.value !== value)) {
    return invalid("Every tile in a group must have the same number.");
  }

  const colors = numbered.map((tile) => tile.color);
  if (new Set(colors).size !== colors.length) {
    return invalid("A color can appear only once in a group.");
  }

  return { valid: true, kind: "group", points: value * tiles.length, reason: null };
}

function validateRun(tiles: Tile[]): MeldValidation {
  if (tiles.length < 3) return invalid("A run must contain at least three tiles.");
  if (tiles.length > 13) return invalid("A run cannot be longer than 13 tiles.");

  const numbered = tiles
    .map((tile, index) => ({ tile, index }))
    .filter(({ tile }) => !tile.joker);
  if (numbered.length === 0) return invalid("A meld needs at least one numbered tile.");

  const color = numbered[0]?.tile.color;
  if (!color || numbered.some(({ tile }) => tile.color !== color)) {
    return invalid("Every numbered tile in a run must have the same color.");
  }

  const first = numbered[0];
  if (!first || first.tile.value === null) return invalid("This run has no starting number.");
  const start = first.tile.value - first.index;
  if (start < 1 || start + tiles.length - 1 > 13) {
    return invalid("Runs cannot wrap below 1 or above 13.");
  }

  for (const { tile, index } of numbered) {
    if (tile.value !== start + index) {
      return invalid("Run tiles must be in consecutive order; jokers stand in a specific position.");
    }
  }

  const points = (tiles.length * (2 * start + tiles.length - 1)) / 2;
  return { valid: true, kind: "run", points, reason: null };
}

export function validateMeld(tileIds: string[], tileMap: Record<string, Tile>): MeldValidation {
  const tiles: Tile[] = [];
  for (const id of tileIds) {
    const tile = tileMap[id];
    if (!tile) return invalid("This meld contains an unknown tile.");
    tiles.push(tile);
  }

  const group = validateGroup(tiles);
  if (group.valid) return group;
  const run = validateRun(tiles);
  if (run.valid) return run;
  return invalid(run.reason ?? group.reason ?? "This is not a valid meld.");
}

/**
 * Resolves what each joker represents in a completed meld.
 * Runs always have one exact color/value per position. A joker in a group of
 * three may legally be replaced by either missing color, so both are retained.
 */
export function resolveJokerAssignments(
  tileIds: string[],
  tileMap: Record<string, Tile>,
): Record<string, JokerAssignment> {
  const validation = validateMeld(tileIds, tileMap);
  if (!validation.valid || !tileIds.some((id) => tileMap[id]?.joker)) return {};

  const numbered = tileIds
    .map((id, index) => ({ tile: tileMap[id], index }))
    .filter((entry): entry is { tile: Tile; index: number } => Boolean(entry.tile && !entry.tile.joker));
  const first = numbered[0];
  if (!first || first.tile.value === null) return {};

  const assignments: Record<string, JokerAssignment> = {};
  if (validation.kind === "run") {
    if (!first.tile.color) return {};
    const start = first.tile.value - first.index;
    for (let index = 0; index < tileIds.length; index += 1) {
      const id = tileIds[index];
      if (id && tileMap[id]?.joker) {
        assignments[id] = {
          value: start + index,
          color: first.tile.color,
          possibleColors: [first.tile.color],
        };
      }
    }
    return assignments;
  }

  const usedColors = new Set(numbered.map(({ tile }) => tile.color));
  const possibleColors = TILE_COLORS.filter((color) => !usedColors.has(color));
  for (const id of tileIds) {
    if (tileMap[id]?.joker) {
      assignments[id] = {
        value: first.tile.value,
        color: possibleColors.length === 1 ? possibleColors[0]! : null,
        possibleColors: [...possibleColors],
      };
    }
  }
  return assignments;
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

export function validateTurn(params: {
  previousBoard: Meld[];
  proposedBoard: Meld[];
  rack: string[];
  opened: boolean;
  tiles: Record<string, Tile>;
}): TurnValidation {
  const { previousBoard, proposedBoard, rack, opened, tiles } = params;
  if (proposedBoard.length > 106) {
    return { valid: false, reason: "The table contains too many melds.", playedTileIds: [], openingPoints: 0 };
  }

  const previousIds = previousBoard.flatMap((meld) => meld.tileIds);
  const proposedIds = proposedBoard.flatMap((meld) => meld.tileIds);
  if (proposedIds.length > 106 || hasDuplicate(proposedIds)) {
    return { valid: false, reason: "Every tile can appear only once on the table.", playedTileIds: [], openingPoints: 0 };
  }

  const proposedSet = new Set(proposedIds);
  const missingPreviousIds = previousIds.filter((id) => !proposedSet.has(id));
  if (missingPreviousIds.some((id) => tiles[id]?.joker)) {
    return {
      valid: false,
      reason: "A retrieved joker must be played in another valid meld during the same turn.",
      playedTileIds: [],
      openingPoints: 0,
    };
  }
  if (missingPreviousIds.length > 0) {
    return { valid: false, reason: "Tiles already on the table cannot return to a rack.", playedTileIds: [], openingPoints: 0 };
  }

  const rackSet = new Set(rack);
  const playedTileIds = proposedIds.filter((id) => !previousIds.includes(id));
  if (playedTileIds.some((id) => !rackSet.has(id))) {
    return { valid: false, reason: "The table contains a tile that is not in your rack.", playedTileIds: [], openingPoints: 0 };
  }
  if (playedTileIds.length === 0) {
    return { valid: false, reason: "Play at least one tile, or draw to end your turn.", playedTileIds: [], openingPoints: 0 };
  }

  for (let index = 0; index < proposedBoard.length; index += 1) {
    const meld = proposedBoard[index];
    if (!meld) continue;
    const result = validateMeld(meld.tileIds, tiles);
    if (!result.valid) {
      return {
        valid: false,
        reason: `Meld ${index + 1}: ${result.reason ?? "Invalid meld."}`,
        playedTileIds: [],
        openingPoints: 0,
      };
    }
  }

  if (opened) {
    return { valid: true, reason: null, playedTileIds, openingPoints: 0 };
  }

  const playedSet = new Set(playedTileIds);
  const openingMelds = proposedBoard.filter((meld) =>
    meld.tileIds.every((id) => playedSet.has(id)),
  );
  const openingPoints = openingMelds.reduce(
    (sum, meld) => sum + validateMeld(meld.tileIds, tiles).points,
    0,
  );
  if (openingPoints < INITIAL_MELD_MINIMUM) {
    return {
      valid: false,
      reason: `Your opening melds total ${openingPoints}; you need at least ${INITIAL_MELD_MINIMUM}.`,
      playedTileIds: [],
      openingPoints,
    };
  }

  return { valid: true, reason: null, playedTileIds, openingPoints };
}

function collectLegalMelds(
  availableTileIds: string[],
  tiles: Record<string, Tile>,
  options: MeldCollectionOptions = {},
): Array<{ tileIds: string[]; points: number }> {
  const available = new Set(availableTileIds);
  const jokers = availableTileIds.filter((tileId) => tiles[tileId]?.joker);
  const candidates = new Map<string, { tileIds: string[]; points: number }>();

  const add = (tileIds: string[]) => {
    if (tileIds.some((tileId) => !available.has(tileId))) return;
    if (options.mustIncludeOneOf && !tileIds.some((tileId) => options.mustIncludeOneOf!.has(tileId))) return;
    const validation = validateMeld(tileIds, tiles);
    if (!validation.valid) return;
    const key = [...tileIds].sort().join("|");
    const existing = candidates.get(key);
    if (!existing || validation.points > existing.points) {
      candidates.set(key, { tileIds: [...tileIds], points: validation.points });
    }
  };

  for (let value = 1; value <= 13; value += 1) {
    const matching = availableTileIds.filter((tileId) => {
      const tile = tiles[tileId];
      return tile && !tile.joker && tile.value === value;
    });
    const choices = [...matching, ...jokers];
    if (options.mustIncludeOneOf && !choices.some((tileId) => options.mustIncludeOneOf!.has(tileId))) continue;
    for (const size of [3, 4]) {
      const choose = (start: number, selected: string[]) => {
        if (options.stopAfterFirst && candidates.size > 0) return;
        if (selected.length === size) {
          add(selected);
          return;
        }
        for (let index = start; index <= choices.length - (size - selected.length); index += 1) {
          const tileId = choices[index];
          if (tileId) choose(index + 1, [...selected, tileId]);
        }
      };
      choose(0, []);
      if (options.stopAfterFirst && candidates.size > 0) return [...candidates.values()];
    }
  }

  for (const color of TILE_COLORS) {
    const numberedByValue = new Map<number, string[]>();
    for (const tileId of availableTileIds) {
      const tile = tiles[tileId];
      if (!tile || tile.joker || tile.color !== color || tile.value === null) continue;
      const matching = numberedByValue.get(tile.value) ?? [];
      matching.push(tileId);
      numberedByValue.set(tile.value, matching);
    }

    for (let start = 1; start <= 11; start += 1) {
      for (let end = start + 2; end <= 13; end += 1) {
        if (options.mustIncludeOneOf) {
          const requiredJokerAvailable = jokers.some((tileId) => options.mustIncludeOneOf!.has(tileId));
          const requiredNumberAvailable = Array.from(numberedByValue.entries()).some(([value, tileIds]) =>
            value >= start
            && value <= end
            && tileIds.some((tileId) => options.mustIncludeOneOf!.has(tileId)),
          );
          if (!requiredJokerAvailable && !requiredNumberAvailable) continue;
        }
        const build = (value: number, selected: string[], usedJokers: Set<string>) => {
          if (options.stopAfterFirst && candidates.size > 0) return;
          if (value > end) {
            add(selected);
            return;
          }
          for (const tileId of numberedByValue.get(value) ?? []) {
            build(value + 1, [...selected, tileId], usedJokers);
          }
          for (const jokerId of jokers) {
            if (usedJokers.has(jokerId)) continue;
            const nextJokers = new Set(usedJokers);
            nextJokers.add(jokerId);
            build(value + 1, [...selected, jokerId], nextJokers);
          }
        };
        build(start, [], new Set());
        if (options.stopAfterFirst && candidates.size > 0) return [...candidates.values()];
      }
    }
  }

  return [...candidates.values()];
}

function hasMeldUsingRackTile(params: LegalMoveParams): boolean {
  const tableIds = params.board.flatMap((meld) => meld.tileIds);
  return collectLegalMelds(
    [...new Set([...tableIds, ...params.rack])],
    params.tiles,
    { mustIncludeOneOf: new Set(params.rack), stopAfterFirst: true },
  ).length > 0;
}

function meldCandidates(params: LegalMoveParams): MeldCandidate[] {
  const tableIds = params.board.flatMap((meld) => meld.tileIds);
  const allIds = [...new Set([...tableIds, ...params.rack])];
  const bitById = new Map(allIds.map((tileId, index) => [tileId, 1n << BigInt(index)]));
  const tableIdsSet = new Set(tableIds);
  const rackIdsSet = new Set(params.rack);

  return collectLegalMelds(allIds, params.tiles).map((candidate) => {
    let mask = 0n;
    let tableMask = 0n;
    let rackMask = 0n;
    for (const tileId of candidate.tileIds) {
      const bit = bitById.get(tileId) ?? 0n;
      mask |= bit;
      if (tableIdsSet.has(tileId)) tableMask |= bit;
      if (rackIdsSet.has(tileId)) rackMask |= bit;
    }
    return { ...candidate, mask, tableMask, rackMask };
  });
}

function canOpenWithCandidates(candidates: MeldCandidate[]): boolean {
  const rackCandidates = candidates
    .filter((candidate) => candidate.tableMask === 0n && candidate.rackMask !== 0n)
    .sort((left, right) => right.points - left.points);
  if (rackCandidates.some((candidate) => candidate.points >= INITIAL_MELD_MINIMUM)) return true;

  const seen = new Set<string>();
  const search = (start: number, usedMask: bigint, points: number): boolean => {
    const key = `${start}:${usedMask}:${points}`;
    if (seen.has(key)) return false;
    seen.add(key);
    for (let index = start; index < rackCandidates.length; index += 1) {
      const candidate = rackCandidates[index];
      if (!candidate || (candidate.mask & usedMask) !== 0n) continue;
      const nextPoints = points + candidate.points;
      if (nextPoints >= INITIAL_MELD_MINIMUM) return true;
      if (search(index + 1, usedMask | candidate.mask, nextPoints)) return true;
    }
    return false;
  };
  return search(0, 0n, 0);
}

/**
 * Returns whether at least one board accepted by validateTurn exists. Opened
 * players are checked with an exact-cover search, so table rearrangements count
 * even when no rack tile can simply be appended to an existing meld.
 */
export function hasLegalMove(params: LegalMoveParams): boolean {
  if (params.rack.length === 0) return false;
  const rackCandidates = meldCandidates({ ...params, board: [] });
  if (!params.opened) return canOpenWithCandidates(rackCandidates);
  if (rackCandidates.length > 0) return true;

  const tableIds = params.board.flatMap((meld) => meld.tileIds);
  if (tableIds.length === 0) return false;

  for (const rackTileId of params.rack) {
    for (const meld of params.board) {
      for (let index = 0; index <= meld.tileIds.length; index += 1) {
        const tileIds = [...meld.tileIds];
        tileIds.splice(index, 0, rackTileId);
        if (validateMeld(tileIds, params.tiles).valid) return true;
      }
    }
  }

  if (!hasMeldUsingRackTile(params)) return false;

  const candidates = meldCandidates(params);

  const allTableMask = candidates.reduce((mask, candidate) => mask | candidate.tableMask, 0n);
  const originalMeldKeys = new Set(params.board.map((meld) => [...meld.tileIds].sort().join("|")));
  const orderedCandidates = [...candidates].sort((left, right) => {
    const leftOriginal = originalMeldKeys.has([...left.tileIds].sort().join("|")) ? 1 : 0;
    const rightOriginal = originalMeldKeys.has([...right.tileIds].sort().join("|")) ? 1 : 0;
    return rightOriginal - leftOriginal || Number(left.rackMask !== 0n) - Number(right.rackMask !== 0n);
  });
  const candidatesByTableBit = new Map<bigint, MeldCandidate[]>();
  for (const candidate of orderedCandidates) {
    for (let bitIndex = 0; bitIndex < 106; bitIndex += 1) {
      const bit = 1n << BigInt(bitIndex);
      if ((candidate.tableMask & bit) === 0n) continue;
      const matching = candidatesByTableBit.get(bit) ?? [];
      matching.push(candidate);
      candidatesByTableBit.set(bit, matching);
    }
  }

  const roots = orderedCandidates
    .filter((candidate) => candidate.rackMask !== 0n)
    .sort((left, right) => Number(left.tableMask !== 0n) - Number(right.tableMask !== 0n));
  const failed = new Set<string>();

  const coverRemainingTable = (coveredTableMask: bigint, usedMask: bigint): boolean => {
    if (coveredTableMask === allTableMask) return true;
    const cacheKey = `${coveredTableMask}:${usedMask}`;
    if (failed.has(cacheKey)) return false;

    let bestOptions: MeldCandidate[] | null = null;
    for (let bitIndex = 0; bitIndex < 106; bitIndex += 1) {
      const bit = 1n << BigInt(bitIndex);
      if ((allTableMask & bit) === 0n || (coveredTableMask & bit) !== 0n) continue;
      const options = (candidatesByTableBit.get(bit) ?? []).filter(
        (candidate) => (candidate.mask & usedMask) === 0n,
      );
      if (options.length === 0) {
        failed.add(cacheKey);
        return false;
      }
      if (!bestOptions || options.length < bestOptions.length) bestOptions = options;
    }

    for (const candidate of bestOptions ?? []) {
      if (coverRemainingTable(coveredTableMask | candidate.tableMask, usedMask | candidate.mask)) return true;
    }
    failed.add(cacheKey);
    return false;
  };

  for (const root of roots) {
    if (coverRemainingTable(root.tableMask, root.mask)) return true;
  }
  return false;
}

export function rackPenalty(rack: string[], tiles: Record<string, Tile>): number {
  return rack.reduce((sum, id) => {
    const tile = tiles[id];
    if (!tile) return sum;
    return sum + (tile.joker ? JOKER_PENALTY : (tile.value ?? 0));
  }, 0);
}

export function turnDuration(mode: "realtime" | "correspondence"): number {
  return mode === "realtime" ? REALTIME_TURN_MS : CORRESPONDENCE_TURN_MS;
}
