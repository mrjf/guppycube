interface VisualTheme {
  id: string;
  name: string;
  note: string;
  className: string;
}

export type ColorTheme = VisualTheme;
export type TileTheme = VisualTheme;

// Room palettes and tile sets are deliberately independent so any material can
// be used on any table without touching tile markup or game logic.
export const COLOR_THEMES: ColorTheme[] = [
  { id: "clubhouse", name: "Clubhouse", note: "Forest felt & warm paper", className: "color-clubhouse" },
  { id: "afterdark", name: "After dark", note: "Midnight indigo & neon", className: "color-afterdark" },
  { id: "poolside", name: "Poolside", note: "Lagoon teal & sea foam", className: "color-poolside" },
  { id: "desert-bloom", name: "Desert bloom", note: "Terracotta & sun-baked sand", className: "color-desert-bloom" },
  { id: "lavender-dusk", name: "Lavender dusk", note: "Plum felt & soft violet", className: "color-lavender-dusk" },
  { id: "cherry-soda", name: "Cherry soda", note: "Deep cherry & fizzy pink", className: "color-cherry-soda" },
  { id: "alpine", name: "Alpine", note: "Pine green & cool stone", className: "color-alpine" },
  { id: "arctic", name: "Arctic", note: "Glacier blue & winter white", className: "color-arctic" },
  { id: "graphite", name: "Graphite", note: "Charcoal felt & silver paper", className: "color-graphite" },
];

export const TILE_THEMES: TileTheme[] = [
  { id: "ivory", name: "Classic ivory", note: "Warm ivory with softly worn edges", className: "tiles-ivory" },
  { id: "moonlight", name: "Moonlight", note: "Cool stone with richer ink", className: "tiles-moonlight" },
  { id: "sea-glass", name: "Sea glass", note: "Translucent coastal color", className: "tiles-sea-glass" },
  { id: "candy", name: "Candy shop", note: "Pastel faces & fruit colors", className: "tiles-candy" },
  { id: "walnut", name: "Walnut type", note: "Woodgrain with carved marks", className: "tiles-walnut" },
  { id: "arcade", name: "Arcade", note: "Dark tiles with electric ink", className: "tiles-arcade" },
  { id: "high-contrast", name: "High contrast", note: "Crisp white with bold marks", className: "tiles-high-contrast" },
];

export function colorThemeById(id: string): ColorTheme {
  return COLOR_THEMES.find((theme) => theme.id === id) ?? COLOR_THEMES[0]!;
}

export function tileThemeById(id: string): TileTheme {
  return TILE_THEMES.find((theme) => theme.id === id) ?? TILE_THEMES[0]!;
}

export function tileThemeIdFromLegacyTheme(id: string | null): string {
  if (id === "afterdark") return "moonlight";
  if (id === "poolside") return "sea-glass";
  return "ivory";
}
