import type { ComputerStrategyId, GameSet, Tile, TurnAction } from "../../schemas";

export interface ComputerTurnContext {
  version: number;
  board: GameSet[];
  rack: string[];
  opened: boolean;
  tiles: Record<string, Tile>;
}

export interface ComputerStrategy {
  id: ComputerStrategyId;
  label: string;
  chooseTurn(context: ComputerTurnContext): TurnAction;
}
