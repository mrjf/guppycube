import { describe, expect, it } from "vitest";
import type { PublicGameState } from "../src/schemas";
import { mergeGameState } from "../src/client/game-state";

function state(version: number): PublicGameState {
  return { version } as PublicGameState;
}

describe("game state merging", () => {
  it("does not let a delayed request overwrite a newer socket update", () => {
    const socketUpdate = state(8);
    expect(mergeGameState(socketUpdate, state(7), "request")).toBe(socketUpdate);
  });

  it("prefers socket updates when the version is unchanged", () => {
    const socketUpdate = state(8);
    expect(mergeGameState(state(8), socketUpdate, "socket")).toBe(socketUpdate);
  });

  it("keeps the current state when a request returns the same version", () => {
    const current = state(8);
    expect(mergeGameState(current, state(8), "request")).toBe(current);
  });
});
