import { validateMeld, validateTurn } from "../../shared/rules";
import { TILE_COLORS } from "../../shared/types";
import type { Meld } from "../../schemas";
import type { ComputerStrategy, ComputerTurnContext } from "./types";

interface MeldCandidate {
  tileIds: string[];
  points: number;
}

function addCandidate(
  candidates: MeldCandidate[],
  tileIds: string[],
  context: ComputerTurnContext,
): void {
  const validation = validateMeld(tileIds, context.tiles);
  if (validation.valid) candidates.push({ tileIds, points: validation.points });
}

function groupCandidates(context: ComputerTurnContext): MeldCandidate[] {
  const candidates: MeldCandidate[] = [];
  for (let value = 1; value <= 13; value += 1) {
    const tileIds = TILE_COLORS.flatMap((color) => {
      const tileId = context.rack.find((id) => {
        const tile = context.tiles[id];
        if (!tile || tile.joker) return false;
        return tile.color === color && tile.value === value;
      });
      return tileId ? [tileId] : [];
    });
    if (tileIds.length >= 3) addCandidate(candidates, tileIds, context);
  }
  return candidates;
}

function runCandidates(context: ComputerTurnContext): MeldCandidate[] {
  const candidates: MeldCandidate[] = [];
  for (const color of TILE_COLORS) {
    const tileIdByValue = new Map<number, string>();
    for (const tileId of context.rack) {
      const tile = context.tiles[tileId];
      if (tile && !tile.joker && tile.color === color && tile.value !== null && !tileIdByValue.has(tile.value)) {
        tileIdByValue.set(tile.value, tileId);
      }
    }

    let run: string[] = [];
    let previousValue = 0;
    for (let value = 1; value <= 14; value += 1) {
      const tileId = tileIdByValue.get(value);
      if (tileId && (run.length === 0 || value === previousValue + 1)) {
        run.push(tileId);
        previousValue = value;
        continue;
      }
      if (run.length >= 3) addCandidate(candidates, run, context);
      run = tileId ? [tileId] : [];
      previousValue = tileId ? value : 0;
    }
  }
  return candidates;
}

function proposedBoard(context: ComputerTurnContext, tileIds: string[]): Meld[] {
  return [
    ...context.board,
    { id: `computer-${context.version + 1}`, tileIds },
  ];
}

export const basicComputerStrategy: ComputerStrategy = {
  id: "basic",
  label: "Basic",
  chooseTurn(context) {
    const minimumPoints = context.opened ? 0 : 30;
    const candidates = [...groupCandidates(context), ...runCandidates(context)]
      .filter((candidate) => candidate.points >= minimumPoints)
      .sort((left, right) => right.points - left.points || right.tileIds.length - left.tileIds.length);

    for (const candidate of candidates) {
      const board = proposedBoard(context, candidate.tileIds);
      const validation = validateTurn({
        previousBoard: context.board,
        proposedBoard: board,
        rack: context.rack,
        opened: context.opened,
        tiles: context.tiles,
      });
      if (validation.valid) return { type: "commit", board };
    }
    return { type: "draw" };
  },
};
