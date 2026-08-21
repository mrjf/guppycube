import type { ComputerStrategyId, Meld, Tile, TurnAction } from "../../schemas";

export interface ComputerTurnContext {
  version: number;
  board: Meld[];
  rack: string[];
  opened: boolean;
  tiles: Record<string, Tile>;
}

export interface ComputerStrategy {
  id: ComputerStrategyId;
  label: string;
  chooseTurn(context: ComputerTurnContext): TurnAction;
}
