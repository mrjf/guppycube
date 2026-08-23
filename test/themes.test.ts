import { describe, expect, it } from "vitest";
import {
  COLOR_THEMES,
  colorThemeById,
  TILE_THEMES,
  tileThemeById,
  tileThemeIdFromLegacyTheme,
} from "../src/client/themes";

describe("appearance themes", () => {
  it("offers a broad, independently mixable set of room and tile themes", () => {
    expect(COLOR_THEMES.length).toBeGreaterThanOrEqual(8);
    expect(TILE_THEMES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(COLOR_THEMES.map((theme) => theme.id)).size).toBe(COLOR_THEMES.length);
    expect(new Set(COLOR_THEMES.map((theme) => theme.className)).size).toBe(COLOR_THEMES.length);
    expect(new Set(TILE_THEMES.map((theme) => theme.id)).size).toBe(TILE_THEMES.length);
    expect(new Set(TILE_THEMES.map((theme) => theme.className)).size).toBe(TILE_THEMES.length);
  });

  it("falls back to the default theme for unknown saved values", () => {
    expect(colorThemeById("missing")).toBe(COLOR_THEMES[0]);
    expect(tileThemeById("missing")).toBe(TILE_THEMES[0]);
  });

  it("maps the original combined themes to matching tile sets", () => {
    expect(tileThemeIdFromLegacyTheme("clubhouse")).toBe("ivory");
    expect(tileThemeIdFromLegacyTheme("afterdark")).toBe("moonlight");
    expect(tileThemeIdFromLegacyTheme("poolside")).toBe("sea-glass");
    expect(tileThemeIdFromLegacyTheme("unknown")).toBe("ivory");
  });
});
