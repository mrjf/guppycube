"""Shared helpers for the guppycube record format: tiles, rules port, seeded shuffle, canonical JSON hashing."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

COLORS = ["c", "s", "o", "i"]
COLOR_NAMES = {"c": "coral", "s": "sun", "o": "ocean", "i": "ink"}
NUM_MIN, NUM_MAX = 1, 13
COPIES = "ab"
OPENING_MINIMUM = 30
WILDCARD_PENALTY = 30
RACK_SIZE = 14


# ---------- tiles ----------

def canonical_tiles() -> list[str]:
    tiles = [f"{c}{n}{k}" for c in COLORS for n in range(NUM_MIN, NUM_MAX + 1) for k in COPIES]
    tiles += ["*a", "*b"]
    assert len(tiles) == 106
    return tiles


@dataclass(frozen=True)
class Tile:
    id: str
    color: str | None
    value: int | None

    @property
    def wild(self) -> bool:
        return self.color is None


def parse_tile(tile_id: str) -> Tile:
    if tile_id.startswith("*"):
        return Tile(tile_id, None, None)
    color = tile_id[0]
    rest = tile_id[1:]
    copy = rest[-1] if rest[-1] in COPIES else ""
    value = int(rest[: len(rest) - len(copy)] if copy else rest)
    assert color in COLORS and NUM_MIN <= value <= NUM_MAX, tile_id
    return Tile(tile_id, color, value)


def loose(tile_id: str) -> str:
    """Drop the copy letter: c7a -> c7, *b -> *."""
    return tile_id[:-1] if tile_id[-1] in COPIES else tile_id


# ---------- rules (port of src/shared/rules.ts) ----------

def validate_group(tiles: list[Tile]):
    if not 3 <= len(tiles) <= 4:
        return None
    numbered = [t for t in tiles if not t.wild]
    if not numbered:
        return None
    value = numbered[0].value
    if any(t.value != value for t in numbered):
        return None
    colors = [t.color for t in numbered]
    if len(set(colors)) != len(colors):
        return None
    return ("group", value * len(tiles))


def validate_run(tiles: list[Tile]):
    if len(tiles) < 3 or len(tiles) > NUM_MAX:
        return None
    numbered = [(i, t) for i, t in enumerate(tiles) if not t.wild]
    if not numbered:
        return None
    color = numbered[0][1].color
    if any(t.color != color for _, t in numbered):
        return None
    first_i, first_t = numbered[0]
    start = first_t.value - first_i
    if start < NUM_MIN or start + len(tiles) - 1 > NUM_MAX:
        return None
    for i, t in numbered:
        if t.value != start + i:
            return None
    points = len(tiles) * (2 * start + len(tiles) - 1) // 2
    return ("run", points)


def validate_meld(tile_ids: list[str]):
    tiles = [parse_tile(t) for t in tile_ids]
    return validate_group(tiles) or validate_run(tiles)


def validate_turn(previous_board, proposed_board, rack, opened):
    """Returns (ok, reason, played, opening_points) mirroring validateTurn in rules.ts."""
    prev_ids = [t for m in previous_board for t in m]
    prop_ids = [t for m in proposed_board for t in m]
    if len(set(prop_ids)) != len(prop_ids):
        return False, "duplicate tile on table", [], 0
    prop_set = set(prop_ids)
    missing = [t for t in prev_ids if t not in prop_set]
    if any(parse_tile(t).wild for t in missing):
        return False, "wildcard removed from table", [], 0
    if missing:
        return False, "table tile returned to rack", [], 0
    rack_set = set(rack)
    prev_set = set(prev_ids)
    played = [t for t in prop_ids if t not in prev_set]
    if any(t not in rack_set for t in played):
        return False, "tile not in rack", [], 0
    if not played:
        return False, "nothing played", [], 0
    for i, meld in enumerate(proposed_board):
        if validate_meld(meld) is None:
            return False, f"meld {i + 1} invalid", [], 0
    if opened:
        return True, None, played, 0
    played_set = set(played)
    opening = [m for m in proposed_board if all(t in played_set for t in m)]
    points = sum(validate_meld(m)[1] for m in opening)
    if points < OPENING_MINIMUM:
        return False, f"opening {points} < {OPENING_MINIMUM}", [], points
    return True, None, played, points


def rack_penalty(rack: list[str]) -> int:
    total = 0
    for t in rack:
        tile = parse_tile(t)
        total += WILDCARD_PENALTY if tile.wild else tile.value
    return total


# ---------- seeded shuffle "fy-sha256/1" ----------

class Prng:
    """Deterministic 32-bit word stream: block_k = SHA-256(seed || uint32be(k))."""

    def __init__(self, seed: bytes):
        self.seed = seed
        self.counter = 0
        self.buffer = b""

    def word(self) -> int:
        if not self.buffer:
            self.buffer = hashlib.sha256(self.seed + self.counter.to_bytes(4, "big")).digest()
            self.counter += 1
        w = int.from_bytes(self.buffer[:4], "big")
        self.buffer = self.buffer[4:]
        return w

    def below(self, n: int) -> int:
        """Uniform integer in [0, n) by rejection sampling."""
        assert n >= 1
        limit = (1 << 32) - ((1 << 32) % n)
        while True:
            w = self.word()
            if w < limit:
                return w % n


def fisher_yates(items, prng: Prng):
    a = list(items)
    for i in range(len(a) - 1, 0, -1):
        j = prng.below(i + 1)
        a[i], a[j] = a[j], a[i]
    return a


def seeded_start(seed: bytes, seats_in_join_order: list[str]):
    """Returns (turn_order, pool, racks) exactly as the spec defines."""
    prng = Prng(seed)
    order = fisher_yates(seats_in_join_order, prng)
    pool = fisher_yates(canonical_tiles(), prng)
    racks = {p: [] for p in order}
    for _ in range(RACK_SIZE):
        for p in order:
            racks[p].append(pool.pop())
    return order, pool, racks


# ---------- canonical JSON + hash chain ----------

def canonical_json(value) -> str:
    # RFC 8785 (JCS) for the subset used by records: objects, arrays, strings, integers, booleans, null.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def event_hash(event: dict) -> str:
    body = {k: v for k, v in event.items() if k not in ("hash", "private")}
    return hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()


def project(event: dict, viewer: str | None, computers: set[str]) -> dict:
    """What a seat sees: private data only on its own events (computers have no secrets)."""
    if "private" not in event:
        return event
    subject = event.get("player")
    if viewer is not None and (subject == viewer or subject in computers):
        return event
    return {k: v for k, v in event.items() if k != "private"}
