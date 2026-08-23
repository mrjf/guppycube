# guppycube game records — format specification (draft 1)

A *record* is the complete, replayable, annotatable account of one guppycube game. It is what a player owns when the game is over, what a post-mortem tool opens, and what the server streams to any client during play. This document specifies `guppycube-record/1`.

Design goals, in priority order: **complete** (everything needed to replay and score the game, with no access to the server), **honest** (a player can verify that the deal and every draw were fair, and that nobody's copy was altered), **private until the table agrees otherwise** (a player's rack is theirs during play), **client-neutral** (plain JSON Lines, one JSON Schema, no guppycube code required to read it), and **annotatable** by people and tools without touching the server's part of the file.

Companion files in `docs/examples/`:

| File | What it is |
| --- | --- |
| `sample-game.guppycube.jsonl` | A complete three-seat game, revealed, with annotations. Verified against everything in this document. |
| `sample-game.seat-ada.during-play.jsonl` | The same game as Ada's client saw it *while it was being played*: her own private data only, no reveal. |
| `sample-game.transcript.txt` | The human-readable transcript of the same game. |
| `record-line.schema.json` | Draft 2020-12 JSON Schema for every line. Compiles under Ajv strict mode (the repo's setting). |
| `seeded-shuffle.ts` | Reference implementation of the verifiable shuffle (WebCrypto; runs in Workers, browsers, Bun, Node). |
| `tools/` | The scripts that produced and checked the sample: `generate-sample.py` (bots + record writer), `verify-record.py` (independent verifier: chain, seed, legality, scores, annotations), `validate-schema.ts` (Ajv run). |

## 1. File shape

A record is UTF-8 **JSON Lines**: one JSON object per line, `\n` separated. Media type `application/x-ndjson`; suggested file name `<table-name>.guppycube.jsonl`. A folded form — a JSON array of the same objects in the same order — is equivalent and is what `Accept: application/json` returns from the API.

Two kinds of lines share a file:

* **Server events** carry `seq` and are produced only by the authoritative game server. They form an ordered, hash-chained log. The first line is always the `game` header.
* **Annotations** carry `id` instead of `seq` and may be appended by anyone: our client, a third-party client, an analysis tool, or a person with a text editor. They refer to turns by number and never alter server events.

A reader must ignore lines whose `type` it does not recognise, and must treat a file with no `end` event as a game still in progress.

## 2. Tiles, melds, boards, seats

Tiles are written as short strings. The exact form has a copy letter because a set has two of every numbered tile:

```
c7a  c7b     coral 7, first and second copy        colors: c coral · s sun · o ocean · i ink
i13b         ink 13, second copy                   numbers: 1–13
*a   *b      the two wildcards
```

Pattern: `^([csoi](1[0-3]|[1-9])|\*)[ab]$`. The letters map to the engine's `TILE_COLORS` (`coral`, `sun`, `ocean`, `ink`) and to the engine ids `coral-7-1` → `c7a`, `wildcard-2` → `*b`. Tile themes re-skin colors; records never mention a theme.

A **meld** is an array of tile ids in table order. Order matters for runs (`["i5a","*a","i7b"]` is 5-6-7 with the wildcard standing for ink 6) and is conventional for groups. A **board** is an array of melds. Server-generated meld ids from the live API are deliberately absent: the server regenerates them every turn and they carry no information.

**Seats** are `p1`…`p4` in join order, assigned in `seat` events. Turn order is a separate permutation published in `start`. Player names live only in `seat` events; everything else refers to seats. The server's internal player UUIDs never appear in a record.

The **loose form** drops copy letters (`c7`, `*`). The two copies of a tile are indistinguishable under every rule, so a board written loosely is semantically complete; tools that need exact ids may assign copies in any consistent way. Exact ids are used wherever hashes are computed (see §5) so that every copy of a record hashes identically.

## 3. Envelope

Every server event has:

| Field | Type | Meaning |
| --- | --- | --- |
| `seq` | integer ≥ 1 | Position in the record. Contiguous, starting at 1 with the `game` header. |
| `at` | integer | Server time, milliseconds since the Unix epoch. Non-decreasing. |
| `type` | string | Event type (§4). |
| `prev` | hex string or null | Hash of the previous event. `null` only on `seq` 1. Optional but recommended. |
| `hash` | hex string | SHA-256 of this event's public projection (§5). Optional but recommended. |
| `private` | object | Data only the subject of the event may see during play (§6). Never hashed. |

Every annotation has `id` (unique within the file), `at`, `type`, `by` and usually `on` (§7).

## 4. Server events

All examples come from the sample game (hashes abbreviated).

### `game` — header, always `seq` 1

```json
{"seq":1,"at":1787427600000,"type":"game","format":"guppycube-record/1",
 "record":{"id":"0b9f0a2e-6c1d-4f2a-9b7e-3d5c8a1f4e21","table":"dorky-puppet-spam","origin":"https://snagsby.com/guppycube"},
 "game":{"mode":"realtime","maxSeats":3},
 "rules":{"colors":["coral","sun","ocean","ink"],"numbers":[1,13],"copies":2,"wildcards":2,"rackSize":14,"openingMinimum":30,"wildcardPenalty":30,"turnMs":120000},
 "policy":{"assists":{"no-move-alert":"default-on","auto-draw":"default-off","rack-meld-highlights":"default-off"},"reveal":"full","retention":"minimal","recordDrafts":false},
 "engine":{"rules":"guppycube-core/1.0.0","shuffle":"fy-sha256/1"},
 "prev":null,"hash":"a7c047d10974…"}
```

`record.id` is unique per game (table names can be reused after a room is deleted). `rules` pins every numeric parameter a replayer needs, so a future variant (three copies, a 40-point opening) stays replayable. `policy` records the table's data choices (§6, and the design doc). `engine` names the rules implementation and the shuffle algorithm, so a verifier knows exactly what to recompute.

### `seat` — a player joined

```json
{"seq":4,"at":1787427693000,"type":"seat","player":{"id":"p3","name":"Guppy Bot","kind":"computer","strategy":"basic"},"host":false}
```

### `assist` — a player changed one of their assists

```json
{"seq":5,"at":1787427702000,"type":"assist","player":"p1","assist":"rack-meld-highlights","enabled":true}
```

Recorded because it matters to a post-mortem ("auto-draw was on"). Initial defaults come from `policy.assists`.

### `start` — the game began

```json
{"seq":6,"at":1787427708000,"type":"start","order":["p2","p3","p1"],
 "shuffleCommit":"47bc6cc7b55bb1e3fad38a77a82b89f5d0fbf16390b3c737f301838213e4a263","dealt":14,"pool":64}
```

`order` is the seating order (the first seat plays first). `shuffleCommit` is SHA-256 of the secret seed that produced the seating order, the pool order, and therefore every rack and every draw (§8). `pool` is the number of tiles left after dealing.

### `deal` — one per seat, in seating order

```json
{"seq":9,"at":1787427708000,"type":"deal","player":"p1","count":14,
 "private":{"rack":["o3a","o9a","o11a","c8b","c6b","o12a","c3a","c7b","*a","o12b","s1a","c5b","c1a","o1b"]}}
```

Everyone sees the count; only `p1` sees the rack during play.

### `turn` — one per turn, numbered `n` from 1

A play:

```json
{"seq":12,"at":1787427783390,"type":"turn","n":3,"player":"p1","action":"play","reason":"player",
 "board":[["c1b","c2b","c3b","c4a"],["c12a","s12b","*b"],["c5b","c6b","c7b","c8b"],["s1a","c1a","o1b"],["o9a","*a","o11a","o12a"]],
 "played":["c5b","c6b","c7b","c8b","s1a","c1a","o1b","o9a","*a","o11a","o12a"],
 "opening":{"points":71}}
```

`board` is the **whole table after the turn** — the same thing the live API accepts as a commit — so a replayer never has to apply a diff and can verify any turn from the previous board plus the player's rack with the engine's `validateTurn`. `played` is the server's list of tiles that left the rack (derivable, included for convenience). `opening` is present only on the turn a player opened.

A draw:

```json
{"seq":16,"at":1787427968495,"type":"turn","n":7,"player":"p2","action":"draw","reason":"timeout","drew":1,"private":{"tile":"s13a"}}
```

`drew` is `0` when the pool was empty (a pass). `reason` is why the turn ended: `player` (the seat acted, human or computer), `timeout` (the clock ran out — if the player had a legal draft staged, the server commits it and the event is `action: "play"`, `reason: "timeout"`), or `auto-draw` (the assist drew because no legal move existed).

### `draft` — an in-progress table layout (optional)

```json
{"seq":13,"at":1787427760000,"type":"draft","n":3,"player":"p1","board":[["c1b","c2b","c3b","c4a"],["c12a","s12b","*b"],["c5b","c6b","c7b"]]}
```

(Illustrative — the sample game has drafts off, so this line does not appear in it.)

Drafts are already visible to everyone at the table during a turn, so they are public. They are only written when `policy.recordDrafts` is true because they are high-volume (one per table change) and mostly interesting for "how did they think" reviews.

### `end` — the game is over

```json
{"seq":22,"at":1787428086312,"type":"end","reason":"out","winner":"p1",
 "scores":{"p1":132,"p2":-72,"p3":-60},
 "racks":{"p1":[],"p2":["i11a","s10a","i6a","s1b","o11b","i10b","i10a","s13a"],"p3":["o6b","s11b","c2a","s11a","o10a","c7a","o3b","o1a","i9a"]}}
```

`reason` is `out` (a rack emptied) or `blocked` (empty pool and a full round of passes; lowest rack value wins). Scores follow the engine: each loser scores minus their rack value (wildcards 30), the winner scores the sum; in a blocked game the differences from the winner's rack are used. `racks` is present when `policy.reveal` is `full` or `final-racks`.

### `reveal` — the key to everything private

```json
{"seq":23,"at":1787428086362,"type":"reveal","seed":"ed99d091…3121c7","algorithm":"fy-sha256/1",
 "unlock":{"7":{"rack":[…]},"8":{"rack":[…]},"9":{"rack":[…]},"11":{"tile":"c4b"},"13":{"tile":"i10a"},…}}
```

Emitted after `end` when `policy.reveal` is `full`. `unlock` maps the `seq` of each event that had a `private` part to that part, so a reader can fill in every rack and every draw without implementing the shuffle. `seed` lets a reader who *does* implement the shuffle (§8) check that the deals and draws were exactly what the commitment promised.

## 5. Integrity: canonical JSON and the hash chain

`hash` is the lowercase hex SHA-256 of the event's **public projection** serialised with the JSON Canonicalization Scheme (RFC 8785): remove `hash` and `private`, sort object keys, no whitespace, integers written plainly. For records this is simply `JSON.stringify` of a key-sorted object; every number in a record is an integer, so no float rules apply. `prev` is part of what is hashed.

Because `private` is excluded, **every seat's stream, the server's full record, and the revealed record all hash identically**. Two players can compare the last hash of their files and know they hold the same game; a sink can detect a gap; and `hash` of the `game` header is a convenient fingerprint for the whole record.

The chain proves integrity, not authorship. A server signature (Ed25519 over the head hash, published with the origin's key) is a compatible later addition and is deliberately not part of draft 1.

## 6. Visibility: what each party sees and when

The `private` object is the only place information that is secret during play may appear. The rules:

1. While a game is in progress, a seat's stream contains the public projection of every event, plus `private` on events whose `player` is that seat.
2. Computer seats have no secrets (our client already shows their racks), so their `private` parts appear in every stream.
3. At `end`, final racks are published according to `policy.reveal` (`full` and `final-racks` include them; `none` omits them, and the scores alone remain).
4. With `policy.reveal` = `full`, the `reveal` event follows, after which the record is complete for everyone. With anything else, no `reveal` is ever emitted and each player's file remains complete only for their own seat. `final-racks` is enough to score and to replay every public turn; `full` is what a real post-mortem wants.

The policy is chosen by the host when the table is created and shown to every player before they sit down — joining is agreeing. `sample-game.seat-ada.during-play.jsonl` shows rule 1 and 2 in practice: Ada's deal and draws carry `private`, Guppy Bot's do too, Bo's do not.

## 7. Annotations

Annotations are lines with an `id`, written by anyone, never by the game server. They are appended after the server events (or kept in a separate file with the same `record.id`; concatenating files is a valid merge). Three types exist in draft 1.

**`note`** — a comment, optionally with marks, optionally anchored to a turn.

```json
{"id":"n-8a1c07","at":1787431746362,"type":"note","by":{"name":"Bo"},"on":{"n":7},"marks":["?"],
 "text":"Lost this turn to the clock while hunting for a rearrangement that was never there."}
```

`marks` use the chess vocabulary: `!` good, `!!` brilliant, `?` mistake, `??` blunder, `!?` interesting, `?!` dubious. A note without `on` is about the game as a whole.

**`line`** — an alternative sequence that *replaces* turn `n` and continues from there.

```json
{"id":"l-c31d5a","at":1787431806362,"type":"line","by":{"name":"Bo"},"on":{"n":1},
 "text":"The other way to open: just this meld for 36, holding the coral run back to extend later.",
 "moves":[{"player":"p2","action":"play","board":[["c12a","s12b","*b"]]}]}
```

Moves use the same shape as `turn` minus the server-only fields. The first move is by the seat whose turn `n` was; later moves follow seating order. A tool can validate a line exactly like the main line because it knows the board and (after reveal) every rack at turn `n`. Anchors inside a line use `{"n":1,"line":"l-c31d5a","i":0}`, which lets notes and sub-lines attach to a variation.

**`eval`** — machine-derived facts about the position after the anchored move.

```json
{"id":"e-0d77b3","at":1787431866362,"type":"eval","by":{"tool":"guppycube-review","version":"0.1.0"},"on":{"n":12},
 "facts":{"rackValue":{"p1":0,"p2":72,"p3":60}}}
```

Well-known keys (all optional, tools may add their own): `rackValue` per seat, `hadLegalMove`, `couldOpen`, `couldGoOut`, `maxPlayable` (the most rack tiles that could legally have been played), `thinkMs`. Facts about a seat's options are only computable for seats whose rack is known — another reason `reveal: full` is the post-mortem default.

`by` is `{"name"}` for people and `{"tool","version"}` for software. Optional `key` and `sig` fields are reserved for signed annotations (a per-device Ed25519 key, no account needed); unsigned annotations are fine.

## 8. The verifiable shuffle: `fy-sha256/1`

The server draws a 32-byte seed from its CSPRNG before the game starts, publishes `SHA-256(seed)` in `start`, and reveals `seed` in `reveal`. Everything random in a game is a pure function of the seed:

```
block_k  = SHA-256(seed || uint32be(k))                     k = 0, 1, 2, …
words    = consecutive big-endian uint32 values read from block_0, block_1, …
below(n) = first word w with w < 2^32 − (2^32 mod n), then w mod n    (rejection sampling, no modulo bias)
shuffle  = Fisher–Yates: for i = len−1 down to 1: j = below(i+1); swap a[i], a[j]
```

One word stream is consumed, in this order:

1. `order` = shuffle of the seat ids in join order (`["p1","p2","p3"]` → `["p2","p3","p1"]` in the sample).
2. `pool` = shuffle of the canonical tile list: `c1a c1b c2a … c13b s1a … i13b *a *b` (colors c, s, o, i; numbers ascending; copy a before b; wildcards last).
3. Dealing: `rackSize` rounds; in each round every seat in seating order takes `pool.pop()` (the last element). This is the order the deal events appear in.
4. Every later draw is `pool.pop()`.

`seeded-shuffle.ts` implements this; `tools/guppyrec.py` is an independent Python implementation used to build the sample, and the two agree on every seed tested. A verifier that recomputes the deal from the revealed seed and replays every turn with the rules engine has checked the server's honesty end to end: the seating, the deal, every draw, every play's legality, and the final score.

Why commit–reveal rather than player-contributed randomness: it is one line in the server and zero work for clients, and it already makes post-hoc cheating by the server detectable. Mixing in a nonce from each client (so the server cannot grind seeds before committing) is a compatible extension: `shuffleCommit` would become a hash over seed plus nonces, and `reveal` would list the nonces.

## 9. Transcript form

The transcript is a lossy, human-friendly rendering of a record (loose tile ids, deltas instead of whole boards, no hashes) in the spirit of chess PGN. Tools generate it from the record; it is also pleasant to paste into a chat.

```
[Format "guppycube-transcript/1"]
[Table "dorky-puppet-spam"]
[Seats "Ada, Bo, Guppy Bot (computer)"]
[Order "Bo, Guppy Bot, Ada"]
[Result "Ada went out; Ada +132, Guppy Bot -60, Bo -72"]

Deal Bo: i11 s10 s7 i6 c3 s1 c4 c12 c1 s12 o11 * c2 i10

1. Bo opens 46: +[c1 c2 c3 c4] +[c12 s12 *] !? {Bo: …} ( 1. Bo: +[c12 s12 *] {Bo: The other way to open …} )
2. Guppy Bot draws c4
3. Ada opens 71: +[c5 c6 c7 c8] +[s1 c1 o1] +[o9 * o11 o12]
6. Ada: -[c12 s12 *] +[o12 c12 s12 *]
7. Bo draws s13 (timeout) ? {Bo: Lost this turn to the clock …}
12. Ada out: +[o3 c3 i3]
```

Grammar, in brief: `n. Name verb: delta marks {author: comment} ( variation )`. Verbs are `opens N` (the opening turn, N points), `out` (went out), `draws [tile] [(timeout|auto)]`, `passes` (empty pool), or nothing for an ordinary play. The delta lists melds removed from the previous table with `-[…]` and melds added with `+[…]`; a meld that only gained a tile appears as one `-` and one `+`. Tiles that appear in added melds but not in removed ones came from the rack. Deals and drawn tiles are shown only when the record contains them (own seat, or after reveal).

A transcript plus the deals contains enough to rebuild an exact record up to copy-letter assignment, which is why the two forms can round-trip for everything except hashes.

## 10. Versioning

`format` in the header is `guppycube-record/<major>`. Adding optional fields or new event/annotation types is not a major change — readers ignore what they do not know. Changing the meaning of an existing field, the hashing rule, or the shuffle algorithm is. `engine.rules` and `engine.shuffle` are versioned separately so a reader can tell which implementation to use without a format bump.
