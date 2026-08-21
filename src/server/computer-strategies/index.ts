import type { ComputerStrategyId } from "../../schemas";
import { basicComputerStrategy } from "./basic";
import type { ComputerStrategy } from "./types";

const computerStrategies: Record<ComputerStrategyId, ComputerStrategy> = {
  basic: basicComputerStrategy,
};

export function getComputerStrategy(strategyId: ComputerStrategyId): ComputerStrategy {
  return computerStrategies[strategyId];
}

export type { ComputerStrategy, ComputerTurnContext } from "./types";
