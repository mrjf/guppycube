# guppycube

A complete online tile-table game for 2–4 players. It supports live 1-minute turns and 72-hour correspondence turns, with an authoritative rules engine, private racks, persistent rooms, hibernating WebSockets, and modular tile designs.

## Stack

- Bun package manager and scripts
- React 19 + Vite 8 client
- Hono API on Cloudflare Workers
- One central Worker API with a SQLite-backed Durable Object state partition per game room
- WebSocket Hibernation API for realtime updates
- Durable Object alarms for turn deadlines
- Draft 2020-12 JSON Schemas with derived TypeScript types
- Strict, build-time Ajv validators for HTTP, WebSocket, RPC, and stored data

The project uses only services available on the Cloudflare Workers Free plan. Static assets and the API deploy together as one Worker.

## Run locally

```bash
bun install
bun run dev
```

Use Bun 1.4.0 or newer, then open the shown local URL. If a Bono-compatible local Dev Hub is running, the Vite server registers automatically and keeps its entry alive with a five-second heartbeat. Hub discovery is optional and never blocks the game.

To test multiplayer, create a room in one browser and open the invite in another browser/profile. The timeout E2E cases use a loopback-only per-room override so they do not wait for the production one-minute deadline.

Local development rooms survive reloads and dev-server restarts. Room state is stored in `.wrangler/state`. Ordinary visits use an API-scoped `HttpOnly` browser cookie, while the copy button creates a portable personal URL containing that player’s secure link credential; a new browser can use the URL without a cookie. The host can also copy a rejoin link beside any other human player, before or after the game starts. Creating a new host-issued link replaces that player’s previous host-issued link without invalidating their original login. Use the in-game exit action when you intentionally want to return to the new/join table screen.

Useful checks:

```bash
bun run test
bun run test:e2e
bun run check
bun run deploy:dry
```

During loopback development, `/admin/schemas` provides a searchable inventory of every business, API, and system schema; `/api/admin/schemas` returns the validated catalog. These admin routes are unavailable on deployed/non-loopback hosts because the game intentionally has no user-account authentication.

The production app is mounted at `/guppycube/`. Its HTML, JavaScript, and CSS are static assets, including the SPA fallback for `/guppycube/room/<room-code>`. Only `/guppycube/api/*` runs the central Worker API. API and WebSocket URLs derive from the deployment base automatically, while local development remains mounted at `/`.

## Deploy to Cloudflare

Log in once, then run the production quality gate and deploy:

```bash
bunx wrangler login
bun run deploy
```

`bun run deploy` regenerates validators and Worker types, type-checks, runs the unit and Worker integration suite, builds the static client, and publishes the Worker plus its routes. Wrangler creates the SQLite Durable Object namespace from `wrangler.jsonc` during the first deploy. The core game needs no separate application database, queue, KV namespace, or paid service; SMS turn notifications additionally require the five Twilio secrets declared in `wrangler.jsonc`.

Free-plan limits are account-wide. When a limit is reached, Cloudflare rejects additional operations until the daily allowance resets; the app does not silently incur paid overages.

## Rules implemented

- 106 tiles: two copies of 1–13 in four colors, plus two wilcards
- 14 tiles dealt to each player
- Opening sets must total at least 30 and use only the player's rack while leaving existing table sets unchanged; later turns may rearrange the table
- Groups: 3–4 equal numbers in distinct colors
- Runs: 3+ consecutive numbers in one color, bounded by 1 and 13
- Positional wilcard validation and represented-value scoring
- Full table rearrangement after a player has opened
- Draw one tile to end a turn
- First empty rack wins; remaining rack values determine scoring; wilcards count 30
- When the pool is empty and every player passes, the lowest rack value wins
- Official highest-tile starting player, 1-minute live deadlines, 3-tile incomplete-turn penalties, and 72-hour correspondence deadlines
- Extensible per-player assists, beginning with a no-legal-move alert and server-side auto-draw
- Shared rack + felt move analysis covering openings, rack-only sets, felt extensions, wildcard replay, and full rearrangements; the in-game Move Finder can list and stage proven plays

When a table is created, each assist can be allowed on by default, allowed off by default, or disallowed. Players may change any allowed assist for their own seat. Choices are persisted in the room, and auto-draw runs from Durable Object state and alarms, so it continues to work while that player is offline.

The client stages table changes locally. An illegal layout never mutates the shared table: the server rejects it and leaves the player's draft visible for correction.

## Add an appearance theme

Room colors and tile visuals are deliberately independent from each other and from game logic:

1. Add a room palette to `COLOR_THEMES` in `src/client/themes.ts`, then add its matching `.color-yourname` variables in `src/client/styles.css`.
2. Add a tile set to `TILE_THEMES`, then add its matching `.tiles-yourname` variables for the tile face, edge, colored marks, shape, and texture.

Players can mix any room palette with any tile set from the Appearance panel, and both choices persist on their device. The game includes nine room palettes and seven tile sets as working examples.

## Project map

```text
src/schemas.ts            Canonical business, API, and system JSON Schemas
src/validation.ts         Typed standalone-validator registry
src/schema-catalog.ts     Complete searchable schema inventory
src/dev-registry.ts       Optional local Dev Hub heartbeat client
src/shared/rules.ts       Pure tile, set, turn, and scoring rules
src/server/game-room.ts   Persistent room state, timers, capabilities, WebSockets
src/server/index.ts       Hono API and Worker entrypoint
src/client/               React game UI and modular themes
scripts/                  Build-time validator generation
e2e/                      Live Playwright coverage for app and Dev Hub
test/                     Rules, schema, and Durable Object integration tests
wrangler.jsonc            Free-tier Cloudflare deployment config
```
