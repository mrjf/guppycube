import type { GameSet, Tile, TileColor } from "./types";
import {
  TILE_COLORS,
  TILE_COPIES_PER_NUMBER_AND_COLOR,
  TILE_NUMBER_MAX,
  TILE_NUMBER_MIN,
  TILE_SET_SIZE,
  WILCARD_TILE_COUNT,
} from "./types";

export const INITIAL_RACK_SIZE = 14;
export const INITIAL_SET_MINIMUM = 30;
export const WILCARD_PENALTY = 30;
export const REALTIME_TURN_MS = 1 * 60 * 1000;
export const CORRESPONDENCE_TURN_MS = 72 * 60 * 60 * 1000;

export type SetKind = "group" | "run";

export interface SetValidation {
  valid: boolean;
  kind: SetKind | null;
  points: number;
  reason: string | null;
}

export interface TurnValidation {
  valid: boolean;
  reason: string | null;
  playedTileIds: string[];
  openingPoints: number;
}

export interface WilcardAssignment {
  value: number;
  color: TileColor | null;
  possibleColors: TileColor[];
}

export interface LegalMoveParams {
  board: GameSet[];
  rack: string[];
  opened: boolean;
  tiles: Record<string, Tile>;
}

export type LegalMoveKind = "opening" | "rack-set" | "table-extension" | "rearrangement";

export interface LegalMove {
  board: GameSet[];
  playedTileIds: string[];
  openingPoints: number;
  kind: LegalMoveKind;
}

export interface LegalMoveAnalysis {
  legal: boolean;
  moves: LegalMove[];
  truncated: boolean;
  reason: string | null;
}

interface SetCandidate {
  tileIds: string[];
  points: number;
  mask: bigint;
  tableMask: bigint;
  rackMask: bigint;
}

interface SetCollectionOptions {
  mustIncludeOneOf?: Set<string>;
  stopAfterFirst?: boolean;
}

export function createTileSet(): Record<string, Tile> {
  const tiles: Record<string, Tile> = {};

  for (const color of TILE_COLORS) {
    for (let copy = 1; copy <= TILE_COPIES_PER_NUMBER_AND_COLOR; copy += 1) {
      for (let value = TILE_NUMBER_MIN; value <= TILE_NUMBER_MAX; value += 1) {
        const id = `${color}-${value}-${copy}`;
        tiles[id] = { id, color, value, wilcard: false };
      }
    }
  }

  for (let index = 1; index <= WILCARD_TILE_COUNT; index += 1) {
    const id = `wilcard-${index}`;
    tiles[id] = { id, color: null, value: null, wilcard: true };
  }
  return tiles;
}

function invalid(reason: string): SetValidation {
  return { valid: false, kind: null, points: 0, reason };
}

function validateGroup(tiles: Tile[]): SetValidation {
  if (tiles.length < 3 || tiles.length > 4) {
    return invalid("A group must contain three or four tiles.");
  }

  const numbered = tiles.filter((tile) => !tile.wilcard);
  if (numbered.length === 0) return invalid("A set needs at least one numbered tile.");

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

function validateRun(tiles: Tile[]): SetValidation {
  if (tiles.length < 3) return invalid("A run must contain at least three tiles.");
  if (tiles.length > TILE_NUMBER_MAX) return invalid(`A run cannot be longer than ${TILE_NUMBER_MAX} tiles.`);

  const numbered = tiles
    .map((tile, index) => ({ tile, index }))
    .filter(({ tile }) => !tile.wilcard);
  if (numbered.length === 0) return invalid("A set needs at least one numbered tile.");

  const color = numbered[0]?.tile.color;
  if (!color || numbered.some(({ tile }) => tile.color !== color)) {
    return invalid("Every numbered tile in a run must have the same color.");
  }

  const first = numbered[0];
  if (!first || first.tile.value === null) return invalid("This run has no starting number.");
  const start = first.tile.value - first.index;
  if (start < TILE_NUMBER_MIN || start + tiles.length - 1 > TILE_NUMBER_MAX) {
    return invalid(`Runs cannot wrap below ${TILE_NUMBER_MIN} or above ${TILE_NUMBER_MAX}.`);
  }

  for (const { tile, index } of numbered) {
    if (tile.value !== start + index) {
      return invalid("Run tiles must be in consecutive order; wilcards stand in a specific position.");
    }
  }

  const points = (tiles.length * (2 * start + tiles.length - 1)) / 2;
  return { valid: true, kind: "run", points, reason: null };
}

export function validateSet(tileIds: string[], tileMap: Record<string, Tile>): SetValidation {
  const tiles: Tile[] = [];
  for (const id of tileIds) {
    const tile = tileMap[id];
    if (!tile) return invalid("This set contains an unknown tile.");
    tiles.push(tile);
  }

  const group = validateGroup(tiles);
  if (group.valid) return group;
  const run = validateRun(tiles);
  if (run.valid) return run;
  return invalid(run.reason ?? group.reason ?? "This is not a valid set.");
}

/**
 * Resolves what each wilcard represents in a completed set.
 * Runs always have one exact color/value per position. A wilcard in a group of
 * three may legally be replaced by either missing color; choose the first one
 * for a stable display while retaining both legal choices.
 */
export function resolveWilcardAssignments(
  tileIds: string[],
  tileMap: Record<string, Tile>,
): Record<string, WilcardAssignment> {
  const validation = validateSet(tileIds, tileMap);
  if (!validation.valid || !tileIds.some((id) => tileMap[id]?.wilcard)) return {};

  const numbered = tileIds
    .map((id, index) => ({ tile: tileMap[id], index }))
    .filter((entry): entry is { tile: Tile; index: number } => Boolean(entry.tile && !entry.tile.wilcard));
  const first = numbered[0];
  if (!first || first.tile.value === null) return {};

  const assignments: Record<string, WilcardAssignment> = {};
  if (validation.kind === "run") {
    if (!first.tile.color) return {};
    const start = first.tile.value - first.index;
    for (let index = 0; index < tileIds.length; index += 1) {
      const id = tileIds[index];
      if (id && tileMap[id]?.wilcard) {
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
    if (tileMap[id]?.wilcard) {
      assignments[id] = {
        value: first.tile.value,
        color: possibleColors[0] ?? null,
        possibleColors: [...possibleColors],
      };
    }
  }
  return assignments;
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function setKey(set: GameSet): string {
  return set.tileIds.join("|");
}

function preservesExistingSets(previousBoard: GameSet[], proposedBoard: GameSet[]): boolean {
  const proposedSetKeys = new Set(proposedBoard.map(setKey));
  return previousBoard.every((set) => proposedSetKeys.has(setKey(set)));
}

export function validateTurn(params: {
  previousBoard: GameSet[];
  proposedBoard: GameSet[];
  rack: string[];
  opened: boolean;
  tiles: Record<string, Tile>;
}): TurnValidation {
  const { previousBoard, proposedBoard, rack, opened, tiles } = params;
  if (proposedBoard.length > TILE_SET_SIZE) {
    return { valid: false, reason: "The table contains too many sets.", playedTileIds: [], openingPoints: 0 };
  }

  const previousIds = previousBoard.flatMap((set) => set.tileIds);
  const proposedIds = proposedBoard.flatMap((set) => set.tileIds);
  if (proposedIds.length > TILE_SET_SIZE || hasDuplicate(proposedIds)) {
    return { valid: false, reason: "Every tile can appear only once on the table.", playedTileIds: [], openingPoints: 0 };
  }

  const proposedSet = new Set(proposedIds);
  const missingPreviousIds = previousIds.filter((id) => !proposedSet.has(id));
  if (missingPreviousIds.some((id) => tiles[id]?.wilcard)) {
    return {
      valid: false,
      reason: "A retrieved wilcard must be played in another valid set during the same turn.",
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

  if (!opened && !preservesExistingSets(previousBoard, proposedBoard)) {
    return {
      valid: false,
      reason: "Your opening turn can only use tiles from your rack; existing sets must stay unchanged.",
      playedTileIds: [],
      openingPoints: 0,
    };
  }

  for (let index = 0; index < proposedBoard.length; index += 1) {
    const set = proposedBoard[index];
    if (!set) continue;
    const result = validateSet(set.tileIds, tiles);
    if (!result.valid) {
      return {
        valid: false,
        reason: `Set ${index + 1}: ${result.reason ?? "Invalid set."}`,
        playedTileIds: [],
        openingPoints: 0,
      };
    }
  }

  if (opened) {
    return { valid: true, reason: null, playedTileIds, openingPoints: 0 };
  }

  const playedSet = new Set(playedTileIds);
  const openingSets = proposedBoard.filter((set) =>
    set.tileIds.every((id) => playedSet.has(id)),
  );
  const openingPoints = openingSets.reduce(
    (sum, set) => sum + validateSet(set.tileIds, tiles).points,
    0,
  );
  if (openingPoints < INITIAL_SET_MINIMUM) {
    return {
      valid: false,
      reason: `Your opening sets total ${openingPoints}; you need at least ${INITIAL_SET_MINIMUM}.`,
      playedTileIds: [],
      openingPoints,
    };
  }

  return { valid: true, reason: null, playedTileIds, openingPoints };
}

function collectLegalSets(
  availableTileIds: string[],
  tiles: Record<string, Tile>,
  options: SetCollectionOptions = {},
): Array<{ tileIds: string[]; points: number }> {
  const available = new Set(availableTileIds);
  const wilcards = availableTileIds.filter((tileId) => tiles[tileId]?.wilcard);
  const candidates = new Map<string, { tileIds: string[]; points: number }>();

  const add = (tileIds: string[]) => {
    if (tileIds.some((tileId) => !available.has(tileId))) return;
    if (options.mustIncludeOneOf && !tileIds.some((tileId) => options.mustIncludeOneOf!.has(tileId))) return;
    const validation = validateSet(tileIds, tiles);
    if (!validation.valid) return;
    const key = [...tileIds].sort().join("|");
    const existing = candidates.get(key);
    if (!existing || validation.points > existing.points) {
      candidates.set(key, { tileIds: [...tileIds], points: validation.points });
    }
  };

  for (let value = TILE_NUMBER_MIN; value <= TILE_NUMBER_MAX; value += 1) {
    const matching = availableTileIds.filter((tileId) => {
      const tile = tiles[tileId];
      return tile && !tile.wilcard && tile.value === value;
    });
    const choices = [...matching, ...wilcards];
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
      if (!tile || tile.wilcard || tile.color !== color || tile.value === null) continue;
      const matching = numberedByValue.get(tile.value) ?? [];
      matching.push(tileId);
      numberedByValue.set(tile.value, matching);
    }

    for (let start = TILE_NUMBER_MIN; start <= TILE_NUMBER_MAX - 2; start += 1) {
      for (let end = start + 2; end <= TILE_NUMBER_MAX; end += 1) {
        if (options.mustIncludeOneOf) {
          const requiredWilcardAvailable = wilcards.some((tileId) => options.mustIncludeOneOf!.has(tileId));
          const requiredNumberAvailable = Array.from(numberedByValue.entries()).some(([value, tileIds]) =>
            value >= start
            && value <= end
            && tileIds.some((tileId) => options.mustIncludeOneOf!.has(tileId)),
          );
          if (!requiredWilcardAvailable && !requiredNumberAvailable) continue;
        }
        const build = (value: number, selected: string[], usedWilcards: Set<string>) => {
          if (options.stopAfterFirst && candidates.size > 0) return;
          if (value > end) {
            add(selected);
            return;
          }
          for (const tileId of numberedByValue.get(value) ?? []) {
            build(value + 1, [...selected, tileId], usedWilcards);
          }
          for (const wilcardId of wilcards) {
            if (usedWilcards.has(wilcardId)) continue;
            const nextWilcards = new Set(usedWilcards);
            nextWilcards.add(wilcardId);
            build(value + 1, [...selected, wilcardId], nextWilcards);
          }
        };
        build(start, [], new Set());
        if (options.stopAfterFirst && candidates.size > 0) return [...candidates.values()];
      }
    }
  }

  return [...candidates.values()];
}

function setCandidates(params: LegalMoveParams): SetCandidate[] {
  const tableIds = params.board.flatMap((set) => set.tileIds);
  const allIds = [...new Set([...tableIds, ...params.rack])];
  const bitById = new Map(allIds.map((tileId, index) => [tileId, 1n << BigInt(index)]));
  const tableIdsSet = new Set(tableIds);
  const rackIdsSet = new Set(params.rack);

  return collectLegalSets(allIds, params.tiles).map((candidate) => {
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

export interface LegalMoveSearchOptions {
  maxMoves?: number;
}

function boardMembershipKey(tileIds: string[]): string {
  return [...tileIds].sort().join("|");
}

function boardKey(board: GameSet[]): string {
  return board.map((set) => boardMembershipKey(set.tileIds)).sort().join("||");
}

function boardFromCandidates(candidates: SetCandidate[], originalBoard: GameSet[]): GameSet[] {
  const originalByMembership = new Map<string, GameSet[]>();
  for (const set of originalBoard) {
    const matches = originalByMembership.get(boardMembershipKey(set.tileIds)) ?? [];
    matches.push(set);
    originalByMembership.set(boardMembershipKey(set.tileIds), matches);
  }

  return candidates.map((candidate, index) => {
    const membership = boardMembershipKey(candidate.tileIds);
    const matchingOriginals = originalByMembership.get(membership);
    const original = matchingOriginals?.shift();
    return {
      id: original?.id ?? `analysis-${index + 1}`,
      tileIds: [...candidate.tileIds],
    };
  });
}

/**
 * Enumerates playable boards from the current rack and felt. The search is
 * deliberately shared by the server's auto-draw decision and diagnostics so
 * a boolean answer can never disagree with the move it claims to represent.
 *
 * `maxMoves` limits only the returned explanations; `truncated` tells callers
 * that more legal boards may exist. The default is enough for a useful move
 * finder while the server passes 1 for a cheap existence check.
 */
export function findLegalMoves(
  params: LegalMoveParams,
  options: LegalMoveSearchOptions = {},
): LegalMoveAnalysis {
  const maxMoves = Math.max(1, options.maxMoves ?? 50);
  const moves: LegalMove[] = [];
  const seenBoards = new Set<string>();
  let truncated = false;

  const addMove = (candidateSets: SetCandidate[], kind: LegalMoveKind): void => {
    const board = boardFromCandidates(candidateSets, params.board);
    const key = boardKey(board);
    if (seenBoards.has(key)) return;
    const validation = validateTurn({
      previousBoard: params.board,
      proposedBoard: board,
      rack: params.rack,
      opened: params.opened,
      tiles: params.tiles,
    });
    if (!validation.valid) return;
    if (moves.length >= maxMoves) {
      truncated = true;
      return;
    }
    seenBoards.add(key);
    moves.push({
      board,
      playedTileIds: validation.playedTileIds,
      openingPoints: validation.openingPoints,
      kind,
    });
  };

  const originalBoardCandidates = params.board.map((set) => ({
    tileIds: [...set.tileIds],
    points: validateSet(set.tileIds, params.tiles).points,
    mask: 0n,
    tableMask: 0n,
    rackMask: 0n,
  }));

  if (params.rack.length === 0) {
    return { legal: false, moves, truncated: false, reason: "Your rack is empty." };
  }

  const rackCandidates = setCandidates({ ...params, board: [] })
    .filter((candidate) => candidate.tableMask === 0n && candidate.rackMask !== 0n)
    .sort((left, right) => right.points - left.points || right.tileIds.length - left.tileIds.length);

  if (!params.opened) {
    const searchOpening = (start: number, usedMask: bigint, points: number, selected: SetCandidate[]): void => {
      for (let index = start; index < rackCandidates.length; index += 1) {
        const candidate = rackCandidates[index];
        if (!candidate || (candidate.mask & usedMask) !== 0n) continue;
        const nextSelected = [...selected, candidate];
        const nextPoints = points + candidate.points;
        if (nextPoints >= INITIAL_SET_MINIMUM) {
          addMove([...originalBoardCandidates, ...nextSelected], "opening");
        }
        if (moves.length >= maxMoves) {
          truncated = true;
          return;
        }
        searchOpening(index + 1, usedMask | candidate.mask, nextPoints, nextSelected);
        if (moves.length >= maxMoves) return;
      }
    };
    searchOpening(0, 0n, 0, []);
    return {
      legal: moves.length > 0,
      moves,
      truncated,
      reason: moves.length > 0 ? null : `No rack-only combination reaches ${INITIAL_SET_MINIMUM} points.`,
    };
  }

  // A new rack-only set is legal for an opened player.
  for (const candidate of rackCandidates) {
    addMove([...originalBoardCandidates, candidate], "rack-set");
    if (moves.length >= maxMoves) {
      return { legal: true, moves, truncated: true, reason: null };
    }
  }

  // Fast path for the common case where a tile joins one existing set.
  for (const rackTileId of params.rack) {
    for (const existingSet of params.board) {
      for (let index = 0; index <= existingSet.tileIds.length; index += 1) {
        const tileIds = [...existingSet.tileIds];
        tileIds.splice(index, 0, rackTileId);
        if (!validateSet(tileIds, params.tiles).valid) continue;
        const candidate: SetCandidate = {
          tileIds,
          points: validateSet(tileIds, params.tiles).points,
          mask: 0n,
          tableMask: 0n,
          rackMask: 0n,
        };
        addMove(
          params.board.map((set) => set === existingSet ? candidate : {
            tileIds: [...set.tileIds],
            points: validateSet(set.tileIds, params.tiles).points,
            mask: 0n,
            tableMask: 0n,
            rackMask: 0n,
          }),
          "table-extension",
        );
        if (moves.length >= maxMoves) {
          return { legal: true, moves, truncated: true, reason: null };
        }
      }
    }
  }

  const tableIds = params.board.flatMap((set) => set.tileIds);
  if (tableIds.length === 0) {
    return {
      legal: moves.length > 0,
      moves,
      truncated,
      reason: moves.length > 0 ? null : "No rack tile can form a valid set.",
    };
  }

  // Search exact covers of every tile already on the felt. The previous
  // implementation covered the union of candidate table tiles; using the
  // actual table mask makes the invariant explicit and protects this check if
  // candidate generation is ever narrowed in the future.
  const candidates = setCandidates(params);
  const allIds = [...new Set([...tableIds, ...params.rack])];
  const bitById = new Map(allIds.map((tileId, index) => [tileId, 1n << BigInt(index)]));
  const tableMaskById = new Map(tableIds.map((tileId) => [tileId, bitById.get(tileId) ?? 0n]));
  const allTableMask = tableIds.reduce((mask, tileId) => mask | (tableMaskById.get(tileId) ?? 0n), 0n);
  const candidatesWithMasks = candidates.map((candidate) => {
    let tableMask = 0n;
    let mask = 0n;
    let rackMask = 0n;
    for (const tileId of candidate.tileIds) {
      const bit = bitById.get(tileId) ?? 0n;
      mask |= bit;
      if (tableMaskById.has(tileId)) tableMask |= bit;
      if (params.rack.includes(tileId)) rackMask |= bit;
    }
    return { ...candidate, mask, tableMask, rackMask };
  });
  const candidatesByTableBit = new Map<bigint, SetCandidate[]>();
  for (const candidate of candidatesWithMasks) {
    for (const tableTileId of tableIds) {
      const bit = tableMaskById.get(tableTileId) ?? 0n;
      if ((candidate.tableMask & bit) === 0n) continue;
      const matching = candidatesByTableBit.get(bit) ?? [];
      matching.push(candidate);
      candidatesByTableBit.set(bit, matching);
    }
  }

  const roots = candidatesWithMasks
    .filter((candidate) => candidate.rackMask !== 0n && candidate.tableMask !== 0n)
    .sort((left, right) => Number(left.tableMask !== 0n) - Number(right.tableMask !== 0n));
  const failed = new Set<string>();

  const coverRemainingTable = (
    coveredTableMask: bigint,
    usedMask: bigint,
    selected: SetCandidate[],
  ): void => {
    if (moves.length >= maxMoves) {
      truncated = true;
      return;
    }
    if (coveredTableMask === allTableMask) {
      addMove(selected, "rearrangement");
      return;
    }
    const cacheKey = `${coveredTableMask}:${usedMask}`;
    if (failed.has(cacheKey)) return;

    let bestOptions: SetCandidate[] | null = null;
    for (const tableTileId of tableIds) {
      const bit = tableMaskById.get(tableTileId) ?? 0n;
      if ((coveredTableMask & bit) !== 0n) continue;
      const optionsForTile = (candidatesByTableBit.get(bit) ?? []).filter(
        (candidate) => (candidate.mask & usedMask) === 0n,
      );
      if (optionsForTile.length === 0) {
        failed.add(cacheKey);
        return;
      }
      if (!bestOptions || optionsForTile.length < bestOptions.length) bestOptions = optionsForTile;
    }

    for (const candidate of bestOptions ?? []) {
      coverRemainingTable(
        coveredTableMask | candidate.tableMask,
        usedMask | candidate.mask,
        [...selected, candidate],
      );
      if (moves.length >= maxMoves) return;
    }
    failed.add(cacheKey);
  };

  for (const root of roots) {
    coverRemainingTable(root.tableMask, root.mask, [root]);
    if (moves.length >= maxMoves) break;
  }

  return {
    legal: moves.length > 0,
    moves,
    truncated,
    reason: moves.length > 0 ? null : "No rack tile can make a valid set on the felt or rearrange the felt into valid sets.",
  };
}

/**
 * Returns whether at least one board accepted by validateTurn exists. Opened
 * players are checked with an exact-cover search, so table rearrangements count
 * even when no rack tile can simply be appended to an existing set.
 */
export function hasLegalMove(params: LegalMoveParams): boolean {
  return findLegalMoves(params, { maxMoves: 1 }).legal;
}

export function rackPenalty(rack: string[], tiles: Record<string, Tile>): number {
  return rack.reduce((sum, id) => {
    const tile = tiles[id];
    if (!tile) return sum;
    return sum + (tile.wilcard ? WILCARD_PENALTY : (tile.value ?? 0));
  }, 0);
}

export function turnDuration(
  mode: "realtime" | "correspondence",
  realtimeDurationMs = REALTIME_TURN_MS,
): number {
  return mode === "realtime" ? realtimeDurationMs : CORRESPONDENCE_TURN_MS;
}
