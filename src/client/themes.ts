export interface TileTheme {
  id: string;
  name: string;
  note: string;
  className: string;
}

// Add a new visual set here, then define its custom properties in styles.css.
// Tile markup and game logic never need to change.
export const TILE_THEMES: TileTheme[] = [
  { id: "clubhouse", name: "Clubhouse", note: "Warm ivory & ink", className: "theme-clubhouse" },
  { id: "afterdark", name: "After dark", note: "Inky neon", className: "theme-afterdark" },
  { id: "poolside", name: "Poolside", note: "Cool & breezy", className: "theme-poolside" },
];

export function themeById(id: string): TileTheme {
  return TILE_THEMES.find((theme) => theme.id === id) ?? TILE_THEMES[0]!;
}

