# guppycube game records — format specification (draft 2)

A *record* is the complete, replayable, annotatable account of one guppycube game. It is what a player owns when the game is over, what a post-mortem tool opens, and what the server streams to any client during play. This document specifies `guppycube-record/2`.

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

## 2. Tiles, sets, boards, seats

Tiles are written as short strings. The exact form has a copy letter because a set has two of every numbered tile:

```
c7a  c7b     coral 7, first and second copy        colors: c coral · s sun · o ocean · i ink
i13b         ink 13, second copy                   numbers: 1–13
*a   *b      the two wilcards
```

Pattern: `^([csoi](1[0-3]|[1-9])|\*)[ab]$`. The letters map to the engine's `TILE_COLORS` (`coral`, `sun`, `ocean`, `ink`) and to the engine ids `coral-7-1` → `c7a`, `wilcard-2` → `*b`. Tile themes re-skin colors; records never mention a theme.

A **set** is an array of tile ids in table order. Order matters for runs (`["i5a","*a","i7b"]` is 5-6-7 with the wilcard standing for ink 6) and is conventional for groups. A **board** is an array of sets. Server-generated set ids from the live API are deliberately absent: the server regenerates them every turn and they carry no information.

**Seats** are `p1`…`p4` in join order, assigned in `seat` events. Turn order is a rotation of join order, beginning with the highest-tile winner, and is published in `start`. Player names live only in `seat` events; everything else refers to seats. The server's internal player UUIDs never appear in a record.

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
{"seq":1,"at":1787427600000,"type":"game","format":"guppycube-record/2",
 "record":{"id":"0b9f0a2e-6c1d-4f2a-9b7e-3d5c8a1f4e21","table":"dorky-puppet-spam","origin":"https://snagsby.com/guppycube"},
 "game":{"mode":"realtime","maxSeats":3},
 "rules":{"colors":["coral","sun","ocean","ink"],"numbers":[1,13],"copies":2,"wilcards":2,"rackSize":14,"openingMinimum":30,"wilcardPenalty":30,"turnMs":60000},
 "policy":{"assists":{"no-move-alert":"default-on","auto-draw":"default-off","rack-set-highlights":"default-off"},"reveal":"full","retention":"minimal","recordDrafts":false},
 "engine":{"rules":"guppycube-core/2.0.0","shuffle":"fy-sha256-highest/1"},
 "prev":null,"hash":"ed76f140ee02…"}
```

`record.id` is unique per game (table names can be reused after a room is deleted). `rules` pins every numeric parameter a replayer needs, so a future variant (three copies, a 40-point opening) stays replayable. `policy` records the table's data choices (§6, and the design doc). `engine` names the rules implementation and the shuffle algorithm, so a verifier knows exactly what to recompute.

### `seat` — a player joined

```json
{"seq":4,"at":1787427693000,"type":"seat","player":{"id":"p3","name":"Guppy Bot","kind":"computer","strategy":"basic"},"host":false}
```

### `assist` — a player changed one of their assists

```json
{"seq":5,"at":1787427702000,"type":"assist","player":"p1","assist":"rack-set-highlights","enabled":true}
```

Recorded because it matters to a post-mortem ("auto-draw was on"). Initial defaults come from `policy.assists`.

### `start` — the game began

```json
{"seq":6,"at":1787427708000,"type":"start","order":["p2","p3","p1"],
 "shuffleCommit":"16421346fa86407cd735f2021d41d2c0560ae00795cc4a8b1cba5ca538091b30","dealt":14,"pool":64}
```

`order` is turn order: join order rotated so the highest-tile winner comes first. `shuffleCommit` is SHA-256 of the secret seed that produced the starting-player draw, the pool order, and therefore every rack and every later draw (§8). `pool` is the number of tiles left after dealing.

### `deal` — one per seat, in join order

```json
{"seq":7,"at":1787427708000,"type":"deal","player":"p1","count":14,
 "private":{"rack":["c4a","c3a","o1b","o11a","o7b","c1a","o12a","o4b","c3b","o9a","c1b","s6b","i4a","o8a"]}}
```

Everyone sees the count; only `p1` sees the rack during play.

### `turn` — one per turn, numbered `n` from 1

A play:

```json
{"seq":12,"at":1787427800861,"type":"turn","n":3,"player":"p1","action":"play","reason":"player",
 "board":[["o12b","c12b","s12a"],["i13b","c13a","*a"],["o7b","o8a","o9a"],["c4a","o4b","i4a"]],
 "played":["o7b","o8a","o9a","c4a","o4b","i4a"],
 "opening":{"points":36}}
```

`board` is the **whole table after the turn** — the same thing the live API accepts as a commit — so a replayer never has to apply a diff and can verify any turn from the previous board plus the player's rack with the engine's `validateTurn`. `played` is the server's list of tiles that left the rack (derivable, included for convenience). `opening` is present only on the turn a player opened.

A draw:

```json
{"seq":10,"at":1787427768000,"type":"turn","n":1,"player":"p2","action":"draw","reason":"timeout","drew":3,
 "private":{"tiles":["s13a","s5a","s1a"]}}
```

`drew` is `0` when the pool was empty (a pass), `1` for an ordinary draw or timeout, and `2` or `3` when an incomplete turn timed out (the count can be short if the pool ran out). A one-tile private payload is `{"tile":"i6a"}`; a multi-tile payload is `{"tiles":["s13a","s5a","s1a"]}`. As with every private field, the payload may be absent from another seat's during-play stream. `reason` is why the turn ended: `player` (the seat acted, human or computer), `timeout` (the clock ran out; an in-progress draft is discarded and draws the three-tile penalty), or `auto-draw` (the assist drew because no legal move existed).

### `draft` — an in-progress table layout (optional)

```json
{"seq":13,"at":1787427760000,"type":"draft","n":3,"player":"p1","board":[["c1b","c2b","c3b","c4a"],["c12a","s12b","*b"],["c5b","c6b","c7b"]]}
```

(Illustrative — the sample game has drafts off, so this line does not appear in it.)

Drafts are already visible to everyone at the table during a turn, so they are public. They are only written when `policy.recordDrafts` is true because they are high-volume (one per table change) and mostly interesting for "how did they think" reviews.

### `end` — the game is over

```json
{"seq":57,"at":1787428603782,"type":"end","reason":"out","winner":"p3",
 "scores":{"p1":-58,"p2":-59,"p3":117},
 "racks":{"p1":["o1b","c1a","c3b","c1b","s6b","i7b","i11b","s7a","o8b","o9b","o4a"],"p2":["c2b","c10a","i5a","i13a","s1b","s1a","c6b","c11b","o2a","i8a"],"p3":[]}}
```

`reason` is `out` (a rack emptied) or `blocked` (empty pool and a full round of passes; lowest rack value wins). Scores follow the engine: each loser scores minus their rack value (wilcards 30), the winner scores the sum; in a blocked game the differences from the winner's rack are used. `racks` is present when `policy.reveal` is `full` or `final-racks`.

### `reveal` — the key to everything private

```json
{"seq":58,"at":1787428603832,"type":"reveal","seed":"98660601…b7756e5","algorithm":"fy-sha256-highest/1",
 "unlock":{"7":{"rack":[…]},"8":{"rack":[…]},"9":{"rack":[…]},"10":{"tiles":["s13a","s5a","s1a"]},"13":{"tile":"i6a"},…}}
```

Emitted after `end` when `policy.reveal` is `full`. `unlock` maps the `seq` of each event that had a `private` part to that part, so a reader can fill in every rack and every draw without implementing the shuffle. `seed` lets a reader who *does* implement the shuffle (§8) check that the deals and draws were exactly what the commitment promised.

## 5. Integrity: canonical JSON and the hash chain

`hash` is the lowercase hex SHA-256 of the event's **public projection** serialised with the JSON Canonicalization Scheme (RFC 8785): remove `hash` and `private`, sort object keys, no whitespace, integers written plainly. For records this is simply `JSON.stringify` of a key-sorted object; every number in a record is an integer, so no float rules apply. `prev` is part of what is hashed.

Because `private` is excluded, **every seat's stream, the server's full record, and the revealed record all hash identically**. Two players can compare the last hash of their files and know they hold the same game; a sink can detect a gap; and `hash` of the `game` header is a convenient fingerprint for the whole record.

The chain proves integrity, not authorship. A server signature (Ed25519 over the head hash, published with the origin's key) is a compatible later addition and is deliberately not part of draft 2.

## 6. Visibility: what each party sees and when

The `private` object is the only place information that is secret during play may appear. The rules:

1. While a game is in progress, a seat's stream contains the public projection of every event, plus `private` on events whose `player` is that seat.
2. Computer seats have no secrets (our client already shows their racks), so their `private` parts appear in every stream.
3. At `end`, final racks are published according to `policy.reveal` (`full` and `final-racks` include them; `none` omits them, and the scores alone remain).
4. With `policy.reveal` = `full`, the `reveal` event follows, after which the record is complete for everyone. With anything else, no `reveal` is ever emitted and each player's file remains complete only for their own seat. `final-racks` is enough to score and to replay every public turn; `full` is what a real post-mortem wants.

The policy is chosen by the host when the table is created and shown to every player before they sit down — joining is agreeing. `sample-game.seat-ada.during-play.jsonl` shows rule 1 and 2 in practice: Ada's deal and draws carry `private`, Guppy Bot's do too, Bo's do not.

## 7. Annotations

Annotations are lines with an `id`, written by anyone, never by the game server. They are appended after the server events (or kept in a separate file with the same `record.id`; concatenating files is a valid merge). Three types exist in draft 2.

**`note`** — a comment, optionally with marks, optionally anchored to a turn.

```json
{"id":"n-8a1c07","at":1787432263832,"type":"note","by":{"name":"Bo"},"on":{"n":1},"marks":["?"],
 "text":"Lost this turn to the clock while hunting for a rearrangement that was never there."}
```

`marks` use the chess vocabulary: `!` good, `!!` brilliant, `?` mistake, `??` blunder, `!?` interesting, `?!` dubious. A note without `on` is about the game as a whole.

**`line`** — an alternative sequence that *replaces* turn `n` and continues from there.

```json
{"id":"l-c31d5a","at":1787432323832,"type":"line","by":{"name":"Guppy Bot"},"on":{"n":2},
 "text":"The other way to open: just this set for 39, holding the coral run back to extend later.",
 "moves":[{"player":"p3","action":"play","board":[["i13b","c13a","*a"]]}]}
```

Moves use the same shape as `turn` minus the server-only fields. The first move is by the seat whose turn `n` was; later moves follow turn order. A tool can validate a line exactly like the main line because it knows the board and (after reveal) every rack at turn `n`. Anchors inside a line use `{"n":2,"line":"l-c31d5a","i":0}`, which lets notes and sub-lines attach to a variation.

**`eval`** — machine-derived facts about the position after the anchored move.

```json
{"id":"e-0d77b3","at":1787432383832,"type":"eval","by":{"tool":"guppycube-review","version":"0.1.0"},"on":{"n":47},
 "facts":{"rackValue":{"p1":58,"p2":59,"p3":0}}}
```

Well-known keys (all optional, tools may add their own): `rackValue` per seat, `hadLegalMove`, `couldOpen`, `couldGoOut`, `maxPlayable` (the most rack tiles that could legally have been played), `thinkMs`. Facts about a seat's options are only computable for seats whose rack is known — another reason `reveal: full` is the post-mortem default.

`by` is `{"name"}` for people and `{"tool","version"}` for software. Optional `key` and `sig` fields are reserved for signed annotations (a per-device Ed25519 key, no account needed); unsigned annotations are fine.

## 8. The verifiable start: `fy-sha256-highest/1`

The server draws a 32-byte seed from its CSPRNG before the game starts, publishes `SHA-256(seed)` in `start`, and reveals `seed` in `reveal`. Everything random in a game is a pure function of the seed:

```
block_k  = SHA-256(seed || uint32be(k))                     k = 0, 1, 2, …
words    = consecutive big-endian uint32 values read from block_0, block_1, …
below(n) = first word w with w < 2^32 − (2^32 mod n), then w mod n    (rejection sampling, no modulo bias)
shuffle  = Fisher–Yates: for i = len−1 down to 1: j = below(i+1); swap a[i], a[j]
```

One word stream is consumed by the two shuffles, in this order:

1. `pool` = shuffle of the canonical tile list: `c1a c1b c2a … c13b s1a … i13b *a *b` (colors c, s, o, i; numbers ascending; copy a before b; wilcards last).
2. Starting-player draw: every seat in join order takes `pool.pop()`. The highest number remains a candidate (a wilcard counts as zero). All tiles drawn in the round are set aside. If the highest number was tied, only the tied seats draw again, in join order, with every new draw also set aside; repeat until one seat wins.
3. Return the set-aside tiles with `pool.push(...drawn)` in the exact order they were drawn, then shuffle the full pool again with the same word stream.
4. `order` = join order rotated to begin with the winning seat. It is never an arbitrary permutation: `p2` winning from `["p1","p2","p3"]` produces `["p2","p3","p1"]`.
5. Dealing: `rackSize` rounds; in each round every seat in **join order** takes `pool.pop()` (the last element). This is the order the deal events appear in, even when a different seat plays first.
6. Every later draw is `pool.pop()`.

`seeded-shuffle.ts` implements this; `tools/guppyrec.py` is an independent Python implementation used to build the sample, and the two agree on every seed tested. A verifier that recomputes the start from the revealed seed and replays every turn with the rules engine has checked the server's honesty end to end: the starting player, the deal, every draw, every play's legality, and the final score.

Why commit–reveal rather than player-contributed randomness: it is one line in the server and zero work for clients, and it already makes post-hoc cheating by the server detectable. Mixing in a nonce from each client (so the server cannot grind seeds before committing) is a compatible extension: `shuffleCommit` would become a hash over seed plus nonces, and `reveal` would list the nonces.

## 9. Transcript form

The transcript is a lossy, human-friendly rendering of a record (loose tile ids, deltas instead of whole boards, no hashes) in the spirit of chess PGN. Tools generate it from the record; it is also pleasant to paste into a chat.

```
[Format "guppycube-transcript/1"]
[Table "dorky-puppet-spam"]
[Seats "Ada, Bo, Guppy Bot (computer)"]
[Order "Bo, Guppy Bot, Ada"]
[Result "Guppy Bot went out; Guppy Bot +117, Ada -58, Bo -59"]

Deal Ada: c4 c3 o1 o11 o7 c1 o12 o4 c3 o9 c1 s6 i4 o8
Deal Bo: i5 s8 o5 i10 c2 s9 c10 i12 s13 s6 i5 i13 s9 s1
Deal Guppy Bot: o12 i9 i13 i3 c12 i11 s11 * s12 c13 s2 c6 c13 o2

1. Bo draws s13 s5 s1 (timeout) ? {Bo: Lost this turn to the clock …}
2. Guppy Bot opens 75: +[o12 c12 s12] +[i13 c13 *] !? {Guppy Bot: …} ( 2. Guppy Bot: +[i13 c13 *] {Guppy Bot: The other way to open …} )
3. Ada opens 36: +[o7 o8 o9] +[c4 o4 i4]
31. Bo opens 61: +[s5 s6 s7 s8 s9] +[i5 i6 i7 i8]
47. Guppy Bot out: +[s2 o2 i2]
```

Grammar, in brief: `n. Name verb: delta marks {author: comment} ( variation )`. Verbs are `opens N` (the opening turn, N points), `out` (went out), `draws [tile…] [(timeout|auto)]`, `passes` (empty pool), or nothing for an ordinary play. A multi-tile timeout lists the tiles in draw order. The delta lists sets removed from the previous table with `-[…]` and sets added with `+[…]`; a set that only gained a tile appears as one `-` and one `+`. Tiles that appear in added sets but not in removed ones came from the rack. Deals and drawn tiles are shown only when the record contains them (own seat, or after reveal).

A transcript plus the deals contains enough to rebuild an exact record up to copy-letter assignment, which is why the two forms can round-trip for everything except hashes.

## 10. Versioning

`format` in the header is `guppycube-record/<major>`. Adding optional fields or new event/annotation types is not a major change — readers ignore what they do not know. Changing the meaning of an existing field, the hashing rule, or the shuffle algorithm is. `engine.rules` and `engine.shuffle` are versioned separately so a reader can tell which implementation to use without a format bump.
