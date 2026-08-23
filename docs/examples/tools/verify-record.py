"""Independent verifier for a guppycube-record/1 file: structure, hash chain, seeded deal, legality, scores, annotations."""
from __future__ import annotations

import hashlib
import json
import re
import sys

from guppyrec import (
    COPIES, OPENING_MINIMUM, event_hash, parse_tile, rack_penalty, seeded_start, validate_meld, validate_turn,
)

EXACT_TILE = re.compile(r"^([csoi](1[0-3]|[1-9])|\*)[ab]$")
SERVER_TYPES = {"game", "seat", "assist", "start", "deal", "turn", "draft", "end", "reveal"}
ANNOTATION_TYPES = {"note", "line", "eval"}
MARKS = {"!", "!!", "?", "??", "!?", "?!"}


def fail(msg):
    raise SystemExit(f"FAIL: {msg}")


def check_board(board):
    for meld in board:
        if not isinstance(meld, list) or not meld:
            fail(f"bad meld {meld}")
        for t in meld:
            if not EXACT_TILE.match(t):
                fail(f"bad tile id {t}")
        if validate_meld(meld) is None:
            fail(f"invalid meld {meld}")


def main(path):
    events, annotations = [], []
    with open(path) as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj["type"] in SERVER_TYPES:
                events.append(obj)
            elif obj["type"] in ANNOTATION_TYPES:
                annotations.append(obj)
            else:
                fail(f"line {line_no}: unknown type {obj['type']}")

    # --- envelope & chain ---
    prev = None
    for i, e in enumerate(events):
        if e["seq"] != i + 1:
            fail(f"seq gap at {e['seq']}")
        if i and e["at"] < events[i - 1]["at"]:
            fail(f"time goes backwards at seq {e['seq']}")
        if e.get("prev") != prev:
            fail(f"prev mismatch at seq {e['seq']}")
        if e.get("hash") != event_hash(e):
            fail(f"hash mismatch at seq {e['seq']}")
        prev = e["hash"]
    header = events[0]
    if header["type"] != "game" or header["format"] != "guppycube-record/1":
        fail("bad header")
    rules = header["rules"]
    if rules["openingMinimum"] != OPENING_MINIMUM:
        fail("verifier only knows openingMinimum 30")

    # --- seats, start, seeded deal ---
    seats = [e["player"] for e in events if e["type"] == "seat"]
    seat_ids = [s["id"] for s in seats]
    if len(set(seat_ids)) != len(seat_ids) or len(seat_ids) > header["game"]["maxSeats"]:
        fail("bad seats")
    computers = {s["id"] for s in seats if s["kind"] == "computer"}
    start = next(e for e in events if e["type"] == "start")
    reveal = next((e for e in events if e["type"] == "reveal"), None)
    if sorted(start["order"]) != sorted(seat_ids):
        fail("start.order is not a permutation of the seats")
    if reveal is None:
        fail("this verifier needs a revealed record")
    seed = bytes.fromhex(reveal["seed"])
    if hashlib.sha256(seed).hexdigest() != start["shuffleCommit"]:
        fail("shuffleCommit does not match the revealed seed")
    if reveal["algorithm"] != header["engine"]["shuffle"] != "fy-sha256/1":
        fail("unknown shuffle algorithm")
    order, pool, racks = seeded_start(seed, seat_ids)
    if order != start["order"]:
        fail(f"seating order mismatch: {order} vs {start['order']}")
    if len(pool) != start["pool"]:
        fail("pool size mismatch")

    # merge the unlock map so every private payload is present
    by_seq = {e["seq"]: e for e in events}
    for seq_str, priv in reveal["unlock"].items():
        target = by_seq[int(seq_str)]
        if "private" in target and target["private"] != priv:
            fail(f"unlock disagrees with inline private at seq {seq_str}")
        target["private"] = priv

    deals = [e for e in events if e["type"] == "deal"]
    if [d["player"] for d in deals] != order:
        fail("deal order mismatch")
    for d in deals:
        if d["private"]["rack"] != racks[d["player"]] or d["count"] != len(racks[d["player"]]):
            fail(f"deal mismatch for {d['player']}")

    # --- replay turns ---
    board = []
    opened = {p: False for p in order}
    turn_no = 0
    empty = 0
    boards_before = {}
    racks_before = {}
    for e in events:
        if e["type"] != "turn":
            continue
        turn_no += 1
        p = e["player"]
        if e["n"] != turn_no or p != order[(turn_no - 1) % len(order)]:
            fail(f"turn {e['n']} out of order")
        if e["reason"] not in ("player", "timeout", "auto-draw"):
            fail(f"turn {e['n']} bad reason")
        boards_before[e["n"]] = [list(m) for m in board]
        racks_before[e["n"]] = {q: list(r) for q, r in racks.items()}
        if e["action"] == "play":
            check_board(e["board"])
            ok, why, played, pts = validate_turn(board, e["board"], racks[p], opened[p])
            if not ok:
                fail(f"turn {e['n']} illegal: {why}")
            if sorted(played) != sorted(e["played"]):
                fail(f"turn {e['n']} played list mismatch")
            if ("opening" in e) != (not opened[p]):
                fail(f"turn {e['n']} opening flag mismatch")
            if "opening" in e and e["opening"]["points"] != pts:
                fail(f"turn {e['n']} opening points mismatch")
            racks[p] = [t for t in racks[p] if t not in set(played)]
            opened[p] = True
            board = e["board"]
            empty = 0
        elif e["action"] == "draw":
            if pool:
                tile = pool.pop()
                if e["drew"] != 1 or e.get("private", {}).get("tile") != tile:
                    fail(f"turn {e['n']} draw mismatch (expected {tile})")
                racks[p].append(tile)
                empty = 0
            else:
                if e["drew"] != 0 or "private" in e:
                    fail(f"turn {e['n']} should be an empty draw")
                empty += 1
        else:
            fail("bad action")
    end = next(e for e in events if e["type"] == "end")
    if end["racks"] != {q: racks[q] for q in order}:
        fail("final racks mismatch")
    scores = {}
    if end["reason"] == "out":
        if racks[end["winner"]]:
            fail("winner still holds tiles")
        total = 0
        for q in order:
            if q != end["winner"]:
                scores[q] = -rack_penalty(racks[q])
                total += rack_penalty(racks[q])
        scores[end["winner"]] = total
    elif end["reason"] == "blocked":
        if empty < len(order):
            fail("blocked end without a full round of passes")
        pens = sorted((rack_penalty(racks[q]), i, q) for i, q in enumerate(order))
        best, _, w = pens[0]
        if w != end["winner"]:
            fail("blocked winner mismatch")
        total = 0
        for pen, _, q in pens:
            if q != w:
                scores[q] = -(pen - best)
                total += pen - best
        scores[w] = total
    if scores != end["scores"]:
        fail(f"scores mismatch {scores} vs {end['scores']}")
    if sum(end["scores"].values()) != 0:
        fail("scores do not sum to zero")

    # --- annotations ---
    ids = set()
    for a in annotations:
        if a["id"] in ids:
            fail(f"duplicate annotation id {a['id']}")
        ids.add(a["id"])
        if "on" in a:
            n = a["on"]["n"]
            if n not in boards_before:
                fail(f"annotation {a['id']} references missing turn {n}")
        if a["type"] == "note":
            for m in a.get("marks", []):
                if m not in MARKS:
                    fail(f"bad mark {m}")
        if a["type"] == "line":
            n = a["on"]["n"]
            b = boards_before[n]
            r = racks_before[n]
            op = {q: any(t["type"] == "turn" and t["action"] == "play" and t["player"] == q and t["n"] < n for t in events) for q in order}
            for i, mv in enumerate(a["moves"]):
                expected_player = order[(n - 1 + i) % len(order)]
                if mv["player"] != expected_player:
                    fail(f"line {a['id']} move {i} wrong player")
                if mv["action"] == "play":
                    check_board(mv["board"])
                    ok, why, played, _ = validate_turn(b, mv["board"], r[mv["player"]], op[mv["player"]])
                    if not ok:
                        fail(f"line {a['id']} move {i} illegal: {why}")
                    r[mv["player"]] = [t for t in r[mv["player"]] if t not in set(played)]
                    op[mv["player"]] = True
                    b = mv["board"]
        if a["type"] == "eval" and "rackValue" in a["facts"]:
            n = a["on"]["n"]
            # rackValue facts describe the position after turn n
            after = {q: list(v) for q, v in racks_before[n].items()}
            t = by_seq_turn = next(x for x in events if x["type"] == "turn" and x["n"] == n)
            if t["action"] == "play":
                after[t["player"]] = [x for x in after[t["player"]] if x not in set(t["played"])]
            elif t["drew"]:
                after[t["player"]].append(t["private"]["tile"])
            for q, v in a["facts"]["rackValue"].items():
                if rack_penalty(after[q]) != v:
                    fail(f"eval {a['id']} rackValue wrong for {q}")

    print(f"OK: {len(events)} server events, {turn_no} turns, {len(annotations)} annotations, chain head {events[-1]['hash'][:12]}…, end={end['reason']} winner={end['winner']}")


if __name__ == "__main__":
    main(sys.argv[1])
