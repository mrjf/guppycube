# guppycube

A complete online tile-table game for 2–4 players. It supports live 2-minute turns and 72-hour correspondence turns, with an authoritative rules engine, private racks, persistent rooms, hibernating WebSockets, and modular tile designs.

guppycube is an original implementation of familiar tile-game mechanics. It is not affiliated with or endorsed by the owners of the Rummikub trademark.

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

Use Bun 1.3.14 or newer, then open the shown local URL. If a Bono-compatible local Dev Hub is running, the Vite server registers automatically and keeps its entry alive with a five-second heartbeat. Hub discovery is optional and never blocks the game.

To test multiplayer, create a room in one browser and open the invite in another browser/profile.

Local development rooms survive reloads and dev-server restarts. Room state is stored in `.wrangler/state`, and an API-scoped `HttpOnly` browser cookie tells the server which player this browser controls. The static client derives only the room code from the shared URL; JavaScript never reads or submits the player capability. Use the in-game exit action when you intentionally want to return to the new/join table screen.

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

`bun run deploy` regenerates validators and Worker types, type-checks, runs the unit and Worker integration suite, builds the static client, and publishes the Worker plus its routes. Wrangler creates the SQLite Durable Object namespace from `wrangler.jsonc` during the first deploy. No application database, queue, KV namespace, paid service, or secret is required.

Free-plan limits are account-wide. When a limit is reached, Cloudflare rejects additional operations until the daily allowance resets; the app does not silently incur paid overages.

## Rules implemented

- 106 tiles: two copies of 1–13 in four colors, plus two jokers
- 14 tiles dealt to each player
- Opening melds must total at least 30 and use only the player's rack; after those melds qualify, the player may also rearrange the table in the same turn
- Groups: 3–4 equal numbers in distinct colors
- Runs: 3+ consecutive numbers in one color, bounded by 1 and 13
- Positional joker validation and represented-value scoring
- Full table rearrangement after a player has opened
- Draw one tile to end a turn
- First empty rack wins; remaining rack values determine scoring; jokers count 30
- When the pool is empty and every player passes, the lowest rack value wins
- Secure random shuffle, 2-minute live deadlines, and 72-hour correspondence deadlines
- Extensible per-player assists, beginning with a no-legal-move alert and server-side auto-draw

When a table is created, each assist can be allowed on by default, allowed off by default, or disallowed. Players may change any allowed assist for their own seat. Choices are persisted in the room, and auto-draw runs from Durable Object state and alarms, so it continues to work while that player is offline.

The client stages table changes locally. An illegal layout never mutates the shared table: the server rejects it and leaves the player's draft visible for correction.

## Add a tile design

Tile visuals are deliberately independent from game logic:

1. Add one entry to `src/client/themes.ts`.
2. Add a matching `.theme-yourname` block in `src/client/styles.css`.
3. Define the semantic variables such as `--tile-face`, `--tile-edge`, `--table`, `--color-coral`, `--color-sun`, `--color-ocean`, and `--color-ink`.

Every tile, meld, rack, and board automatically adopts the new set. The included Clubhouse, After dark, and Poolside themes are working examples.

## Project map

```text
src/schemas.ts            Canonical business, API, and system JSON Schemas
src/validation.ts         Typed standalone-validator registry
src/schema-catalog.ts     Complete searchable schema inventory
src/dev-registry.ts       Optional local Dev Hub heartbeat client
src/shared/rules.ts       Pure tile, meld, turn, and scoring rules
src/server/game-room.ts   Persistent room state, timers, capabilities, WebSockets
src/server/index.ts       Hono API and Worker entrypoint
src/client/               React game UI and modular themes
scripts/                  Build-time validator generation
e2e/                      Live Playwright coverage for app and Dev Hub
test/                     Rules, schema, and Durable Object integration tests
wrangler.jsonc            Free-tier Cloudflare deployment config
```
