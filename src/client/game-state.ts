import type { PublicGameState } from "../schemas";

type GameStateSource = "request" | "socket";

export function mergeGameState(
  current: PublicGameState | null,
  incoming: PublicGameState,
  source: GameStateSource,
): PublicGameState {
  if (!current || incoming.version > current.version) return incoming;
  if (source === "socket" && incoming.version === current.version) return incoming;
  return current;
}
