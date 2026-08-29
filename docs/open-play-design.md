# Open play, owned data — design notes for the user-friendly guppycube

This is the plan for making guppycube a game you can play from any client, with gameplay data that belongs to the players, and with nothing on the site that needs a banner, an account, or an apology. The companion spec, `record-format.md`, defines the game-record format that most of this rests on.

## 1. The promises

Stated as things we can print on the site and keep:

1. **Play with anything.** The game server is the product. `snagsby.com/guppycube` is one client; a terminal program, a bot, a native app, or someone else's website can sit at the same table through the same API, with the schemas published.
2. **Your game is yours.** Every seat can stream its own copy of the game record as it happens — to the browser, to a file, or to a server you run. When the game ends you get the complete record (including everyone's racks, if the table agreed), and you can prove to anyone that it is the real, unaltered game.
3. **We keep only what the table asked us to keep.** A game in progress has to live on our server (a 72-hour correspondence game cannot live in a browser tab). When it ends, the default is that it disappears after a short grace period. Keeping it longer, revealing racks, or recording drafts are table settings that everyone sees before sitting down.
4. **No ads, no third-party cookies, no trackers, no banner.** One first-party, strictly-necessary cookie per table that holds your seat; browser storage only for things you explicitly chose (appearance, your saved games). No analytics scripts, no third-party requests at all.
5. **Post-mortems anywhere.** The record format is open and documented, so our review page, your own tools, or a future analysis bot can all open the same file.

## 2. Where the code is today

The current implementation is closer to this than it looks. The honest audit:

| Criterion | Today | Gap |
| --- | --- | --- |
| Any client can hit the server | JSON API + WebSocket, schema-validated both ways, no accounts. Auth is an `HttpOnly` cookie for ordinary browser visits or a personal player link for portable browser handoff; the API rejects any request with a cross-origin `Origin`, and the WebSocket accepts either credential. Schema catalog exists but is loopback-only. | Bearer tokens, CORS for token requests, WS auth via subprotocol, publish the catalog. |
| Own the gameplay data | The Durable Object stores full state, but "history" is 40 human-readable messages, not moves. Nothing is exportable; nothing is ever deleted. | Replace history with the event record, expose it, add retention and reveal policies, add sinks. |
| No ads / third-party cookies | None. | — |
| No third-party requests | `styles.css` imports DM Sans and Playfair Display from `fonts.googleapis.com` — every page load sends the visitor's IP to Google (an EU court has treated exactly this as a GDPR violation). | Self-host the two font files (both are OFL licensed). |
| No tracking beyond what the user wants | No analytics. `wrangler.jsonc` has Workers Logs on with `head_sampling_rate: 1`, so Cloudflare retains invocation metadata (URL incl. room code, method, status, colo) for every request. | Sample or disable; keep console output free of names and room codes. Check the zone for Bot Fight Mode (`__cf_bm` cookie), Web Analytics, Rocket Loader, Email Obfuscation — all inject scripts or cookies. |
| Nothing requiring a cookie banner | The session cookie is first-party, `HttpOnly`, `SameSite=Lax`, path-scoped to the API, and exists only because you sat down at a table: strictly necessary, consent-exempt. `localStorage` holds appearance and rack preferences the user set themselves. | Keep it that way; add a plain-language data page (transparency is still owed, a banner is not). Shorten `Max-Age` from a year to the life of the game. |
| Post-mortems | Nothing beyond the 12-line activity feed. | The record format, a review page, and a shared rules package. |

Two things already in the codebase make the rest easy: the rules engine is pure and shared (`src/shared/rules.ts`), and every turn is already a *whole proposed board* validated server-side — which is exactly the unit the record stores.

## 3. Architecture

### 3.1 The record is the spine

Today the Durable Object persists a state snapshot and broadcasts per-player views. The change is to make the **event record** (`record-format.md` §4) the thing the room writes first, and to derive everything else from it:

* A `record` table in the room's SQLite: `seq INTEGER PRIMARY KEY, at INTEGER, json TEXT`. Each mutation appends one or more events with `prev`/`hash` computed in the DO (WebCrypto SHA-256, ~50 µs).
* The state snapshot stays as a cache for the current view; `history` becomes a rendering of the last dozen events, produced by one shared function so every client shows the same feed.
* The WebSocket sends `{"type":"event","event":…}` for each new line in addition to the existing `state` snapshots. Third-party clients can ignore snapshots entirely and fold events themselves; ours can keep using snapshots.
* `GET /api/games/:room/record?since=<seq>` returns the caller's seat stream as NDJSON (or a JSON array with `Accept: application/json`). It is the catch-up and export endpoint, and after `end` it serves the merged, revealed record when the policy allows.

Every seat sees its own projection (spec §6): public events plus its own `private` parts. The server does the projection at broadcast time, which it already does for `myRack`.

### 3.2 Two ways to be someone at a table

| | Cookie (our web client) | Bearer token (everyone else) |
| --- | --- | --- |
| How you get it | `POST /api/games` or `/join` sets the `HttpOnly` cookie, as today | Same endpoints with `"credentials":"bearer"` in the body: no cookie, the token comes back in the JSON |
| How you use it | Automatic, same-origin only | `Authorization: Bearer <token>` on HTTP; `Sec-WebSocket-Protocol: guppycube.v1, bearer.<token>` on the socket (the server answers `guppycube.v1`) |
| CORS | None needed; the existing same-origin `Origin` check stays | `Access-Control-Allow-Origin: *` plus preflight for requests carrying `Authorization`. Wildcard origins can never send cookies, so the two modes cannot be confused |
| Principle kept | Page JavaScript never sees the capability (XSS-resistant, as the README promises) | The token is the seat; whoever holds it is the player. No accounts, no passwords, no email |

The server finds the seat for a bearer token by hashing it and comparing against the ≤ 4 `tokenHash` values in the room, so the token is the only credential a client needs to store.

### 3.3 Where a record can go

Each seat chooses, independently and at any time, any combination of:

1. **Their client.** It receives the stream anyway. Ours offers *Keep in this browser* (IndexedDB, listed on a "My games" page, exportable) and *Download*. A third-party client does whatever it likes.
2. **Their server, forwarded by our server.** `PUT /api/games/:room/me/sink {"url":"https://…","authorization":"Bearer …"}` registers a per-seat webhook. The room POSTs NDJSON batches of that seat's stream after each commit, at-least-once, with backoff, and gives up (and says so in the seat's state) after a day of failures. Only `https:` URLs, and the URL is never shown to other seats. This is the one that matters for correspondence games, where no browser is open for days. A forwarding failure never blocks play.
3. **Their server, forwarded by their client.** Equivalent to (1) — the client owns the stream — and keeps our server from ever learning the sink URL. Our web client cannot do this without exposing the token to page JavaScript, so it only offers (2); a third-party client can do either.
4. **Our server**, which is a policy of the table rather than a seat: see below.

Outbound requests from a Durable Object are ordinary `fetch` calls, within the free plan's subrequest budget (one per turn).

### 3.4 Table policies

Set by the host at creation, shown in the lobby to every joiner, and written into the record header so the file itself says what was agreed:

| Policy | Values | Default | Meaning |
| --- | --- | --- | --- |
| `reveal` | `full` · `final-racks` · `none` | `full` | What is published when the game ends. `full` emits the seed and every rack and draw — what a post-mortem needs. `final-racks` shows only what scoring already implies. `none` publishes scores alone. |
| `retention` | `minimal` · `keep` | `minimal` | `minimal`: the record stays fetchable for 24 hours after `end` (so every client and sink can collect it), then the room deletes itself. `keep`: retained 90 days behind a capability link (`/guppycube/review/<room>/<key>`), for tables who want a shared replay without anyone saving a file. |
| `recordDrafts` | boolean | `false` | Whether in-progress table layouts (already visible to the table live) are written to the record. |
| `assists` | existing | existing | Unchanged. |

Independent of policy, rooms that never reach `end` expire: lobbies after 24 hours, abandoned realtime games after 7 days, correspondence games 30 days after the last move (that is ten missed 72-hour turns). All of this is one DO alarm and `storage.deleteAll()`.

### 3.5 A verifiable deal

Today the shuffle uses `crypto.getRandomValues` directly, so nobody can check it. The record spec (§8) replaces it with a seeded start: draw a 32-byte seed, publish its SHA-256 in the `start` event, derive the highest-tile starter, turn order, deal, and pool from it, then reveal the seed at the end. The reference implementation is `docs/examples/seeded-shuffle.ts`; it uses Fisher–Yates with rejection sampling instead of the current `% (index + 1)` (which has a small modulo bias anyway). Cost: one `crypto.subtle.digest` per 8 random words.

### 3.6 Shared rules, published schemas

Third-party clients need three things from us, all cheap:

* The schema catalog that `/api/admin/schemas` already builds, served publicly and read-only at `/guppycube/api/schemas`, plus the record-line schema.
* `@guppycube/core`: `src/shared/rules.ts`, the record types, the seeded shuffle, the transcript renderer, and the hash/verify functions as a zero-dependency ESM package. Our client, the review page, and anyone else use the same legality engine, and the `engine.rules` field in each record names its version.
* A short protocol page: endpoints, auth, event stream, sinks, rate limits, and the policy that we never change `guppycube.v1` semantics without a new subprotocol name.

## 4. The privacy posture, concretely

* **Fonts:** copy DM Sans and Playfair Display `woff2` files into the client bundle, replace the `@import` with `@font-face`. After this the site makes zero third-party requests.
* **Server logs:** set `observability.logs.head_sampling_rate` to `0` in production (or `0.01` while debugging) and say so on the data page. Keep `console.error` payloads to error classes, never names, room codes, or tokens (today they are already free of PII; keep the discipline).
* **Cloudflare as host:** Cloudflare terminates TLS and sees IPs, as any host would. Name them as the processor on the data page. Confirm in the zone dashboard that Bot Fight Mode, Web Analytics, Rocket Loader, and Email Obfuscation are off for `/guppycube/*` — each injects a cookie or a script that would break promise 4.
* **Cookie:** keep `HttpOnly; SameSite=Lax; Secure; Path=/guppycube/api`, but set `Max-Age` to the game's horizon (4 days realtime, 30 days correspondence) and clear it on *Leave table*. It remains strictly necessary and consent-exempt.
* **Browser storage:** appearance preferences stay as they are. Saved games are stored only after the player chose *Keep in this browser*; the choice is remembered and reversible on the "My games" page.
* **The data page** (`/guppycube/data`): one screen, plain English — what we store and for how long (the live game; the record for 24 hours or 90 days per table policy), what the cookie is, what stays in your browser, that there are no analytics or third parties, who hosts it, and how to get or delete your data (download, sink, leave). Not a banner; a page linked from the footer and the lobby.

## 5. What it feels like in our client

**Creating a table.** Below the existing mode, seats and assist rules: *After the game* (reveal everyone's racks for post-mortems · only final racks · nothing) and *Keep on our server* (24 hours · 90 days with a review link). Both default to the friendly-and-minimal choice; both are visible to joiners in the lobby.

**Your seat, any time.** A small *My copy* panel: *Keep in this browser* (off until chosen once, then remembered), *Send to my server* (URL + optional header, registered with the room, status shown: "sent 57 events, last 12:04").

**Game over.** The result card gains a second half: *Your record* — Save in browser · Download `.guppycube.jsonl` · Copy transcript · Open review. If `retention` is `keep`, the shareable review link is here too. If the player chose nothing and the table is `minimal`, the card says plainly that the record disappears in 24 hours.

**Review** (`/guppycube/review`). A static page that works offline: drop a record file on it, or open a retained one by link. It replays turn by turn, shows every rack when the record is revealed, shows time per turn, marks turns where the engine finds a missed legal move or a missed opening (the `eval` facts), and lets you add notes, marks, and alternative lines. *Export* writes the annotated file; *Copy transcript* gives the text form. Nothing is uploaded.

**My games** (`/guppycube/games`). The browser-local list of kept records with export-all and delete-all.

## 6. Decisions to make

1. **Reveal default.** `full` makes post-mortems real but publishes every rack to the table at the end; `final-racks` is closer to the physical game. The proposal is `full`, since the reveal is the point of recording and it is visible before joining.
2. **Hash chain now or later.** It is ~30 lines in the DO plus a canonical-JSON helper; the format works without it (`prev`/`hash` are optional). Proposal: now, because retrofitting it onto records people already saved is ugly.
3. **Server signatures.** Ed25519 over the head hash would let a player prove to a stranger that snagsby.com produced a record. It needs a secret, which the README currently promises the deployment has none of. Proposal: not in draft 1; the format leaves room.
4. **Browser-side forwarding in our client.** It would need the token in page JavaScript. Proposal: keep the `HttpOnly` principle; server-side sinks cover the correspondence case, which is the one that needs it.
5. **Retained records at a capability URL** make "share the replay" trivial but are the one case where we hold a finished game for months. Proposal: keep it opt-in (`keep`) and 90 days.
6. **Name and extension.** `guppycube-record/2`, `<table>.guppycube.jsonl`, `application/x-ndjson`.

## 7. Build order

Each step is shippable on its own and none blocks the others for long.

1. **Quiet wins (an afternoon):** self-host fonts, turn down Workers Logs, shorten the cookie, write the data page, check the zone settings.
2. **The record inside the room:** seeded shuffle with commit, `record` table, event emission with hashes, `GET …/record`, WS `event` messages, `end` + `reveal` per policy, room expiry. Update the `history` rendering to derive from events. Existing rooms upgrade on load (the `upgradeStoredGame` path already exists for this).
3. **Open the door:** bearer credentials, CORS for bearer requests, WS subprotocol auth, public schema catalog, `@guppycube/core`, the protocol page.
4. **Our client's data features:** table policies in the create form and lobby, *My copy* panel, game-over record card, browser-local saves, download, transcript.
5. **Review page** against the same core package, starting with replay and notes; evals and lines after.
6. **Sinks:** registration endpoint, batched forwarding with retries, status in the seat's state.
