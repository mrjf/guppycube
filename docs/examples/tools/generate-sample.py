"""Generate a legal sample game record (guppycube-record/2) with simple bots, plus annotations and a transcript."""
from __future__ import annotations

import hashlib
import itertools
import json
import sys
from collections import defaultdict

from guppyrec import (
    COLORS, COLOR_NAMES, NUM_MIN, NUM_MAX, OPENING_MINIMUM, Prng, canonical_json, event_hash,
    loose, parse_tile, project, rack_penalty, seeded_start, validate_set, validate_turn,
)

SEED = hashlib.sha256(b"guppycube-sample-highest-16").digest()
ORIGIN = "https://snagsby.com/guppycube"
TABLE = "dorky-puppet-spam"
RECORD_ID = "0b9f0a2e-6c1d-4f2a-9b7e-3d5c8a1f4e21"
CREATED_AT = 1787427600000  # 2026-08-22 21:40:00 UTC
TURN_MS = 60000

SEATS = [
    {"id": "p1", "name": "Ada", "kind": "human", "host": True},
    {"id": "p2", "name": "Bo", "kind": "human", "host": False},
    {"id": "p3", "name": "Guppy Bot", "kind": "computer", "strategy": "basic", "host": False},
]
COMPUTERS = {s["id"] for s in SEATS if s["kind"] == "computer"}
NAMES = {s["id"]: s["name"] for s in SEATS}


# ---------- bot ----------

def rack_set_candidates(rack: list[str]):
    """All valid sets formable from the rack (groups and runs, wilcards allowed)."""
    wilds = [t for t in rack if parse_tile(t).wild]
    numbered = [t for t in rack if not parse_tile(t).wild]
    seen = {}

    def add(ids):
        v = validate_set(ids)
        if v is None:
            return
        key = tuple(sorted(ids))
        if key not in seen or seen[key][1] < v[1]:
            seen[key] = (list(ids), v[1])

    # groups
    by_value = defaultdict(list)
    for t in numbered:
        by_value[parse_tile(t).value].append(t)
    for value, ids in by_value.items():
        # one tile per color
        per_color = {}
        for t in ids:
            per_color.setdefault(parse_tile(t).color, t)
        base = list(per_color.values())
        for size in (3, 4):
            for wild_count in range(0, min(len(wilds), 2) + 1):
                need = size - wild_count
                if need < 1 or need > len(base):
                    continue
                for combo in itertools.combinations(base, need):
                    add(list(combo) + wilds[:wild_count])
    # runs
    for color in COLORS:
        by_val = {}
        for t in numbered:
            tile = parse_tile(t)
            if tile.color == color:
                by_val.setdefault(tile.value, t)
        for start in range(NUM_MIN, NUM_MAX - 1):
            for end in range(start + 2, NUM_MAX + 1):
                ids = []
                used_wild = 0
                ok = True
                for v in range(start, end + 1):
                    if v in by_val:
                        ids.append(by_val[v])
                    elif used_wild < len(wilds):
                        ids.append(wilds[used_wild])
                        used_wild += 1
                    else:
                        ok = False
                        break
                if ok and used_wild < len(ids):
                    add(ids)
    return list(seen.values())


def uses_wild(ids):
    return any(parse_tile(t).wild for t in ids)


def choose_disjoint(candidates, minimum_points=0):
    """Greedy disjoint selection: prefer no-wilcard sets, then points."""
    ordered = sorted(candidates, key=lambda c: (uses_wild(c[0]), -c[1], -len(c[0])))
    chosen, used, points = [], set(), 0
    for ids, pts in ordered:
        if any(t in used for t in ids):
            continue
        chosen.append(ids)
        used.update(ids)
        points += pts
    if points < minimum_points:
        return [], 0
    return chosen, points


def extend_table(board, rack):
    """Append single rack tiles to existing sets wherever legal (no wilcards spent this way)."""
    board = [list(m) for m in board]
    rack = list(rack)
    changed = True
    while changed:
        changed = False
        for t in list(rack):
            if parse_tile(t).wild:
                continue
            placed = False
            for set in board:
                for pos in (0, len(set)):
                    trial = set[:pos] + [t] + set[pos:]
                    if validate_set(trial) is not None:
                        set[:] = trial
                        placed = True
                        break
                if placed:
                    break
            if placed:
                rack.remove(t)
                changed = True
    return board, rack


def bot_turn(board, rack, opened):
    """Returns ("play", new_board) or ("draw", None)."""
    if not opened:
        sets, pts = choose_disjoint(rack_set_candidates(rack), OPENING_MINIMUM)
        if not sets:
            return "draw", None
        return "play", [list(m) for m in board] + sets
    sets, _ = choose_disjoint(rack_set_candidates(rack))
    remaining = [t for t in rack if not any(t in m for m in sets)]
    new_board = [list(m) for m in board] + sets
    new_board, remaining = extend_table(new_board, remaining)
    if len(remaining) == len(rack):
        return "draw", None
    return "play", new_board


# ---------- game simulation ----------

def simulate():
    events = []
    at = CREATED_AT
    seq = 0

    def emit(ev, private=None):
        nonlocal seq
        seq += 1
        full = {"seq": seq, "at": at, **ev}
        if private is not None:
            full["private"] = private
        events.append(full)
        return full

    emit({
        "type": "game",
        "format": "guppycube-record/2",
        "record": {"id": RECORD_ID, "table": TABLE, "origin": ORIGIN},
        "game": {"mode": "realtime", "maxSeats": 3},
        "rules": {
            "colors": [COLOR_NAMES[c] for c in COLORS],
            "numbers": [NUM_MIN, NUM_MAX],
            "copies": 2,
            "wilcards": 2,
            "rackSize": 14,
            "openingMinimum": OPENING_MINIMUM,
            "wilcardPenalty": 30,
            "turnMs": TURN_MS,
        },
        "policy": {
            "assists": {"no-move-alert": "default-on", "auto-draw": "default-off", "rack-set-highlights": "default-off"},
            "reveal": "full",
            "retention": "minimal",
            "recordDrafts": False,
        },
        "engine": {"rules": "guppycube-core/2.0.0", "shuffle": "fy-sha256-highest/1"},
    })
    for i, s in enumerate(SEATS):
        at += [0, 41000, 52000][i]
        player = {"id": s["id"], "name": s["name"], "kind": s["kind"]}
        if s["kind"] == "computer":
            player["strategy"] = s["strategy"]
        emit({"type": "seat", "player": player, "host": s["host"]})
    at += 9000
    emit({"type": "assist", "player": "p1", "assist": "rack-set-highlights", "enabled": True})

    at += 6000
    join_order = [s["id"] for s in SEATS]
    order, pool, racks = seeded_start(SEED, join_order)
    emit({
        "type": "start",
        "order": order,
        "shuffleCommit": hashlib.sha256(SEED).hexdigest(),
        "dealt": 14,
        "pool": len(pool),
    })
    for p in join_order:
        emit({"type": "deal", "player": p, "count": 14}, private={"rack": list(racks[p])})

    opened = {p: False for p in order}
    board = []
    turn = 0
    empty_draws = 0
    timer = Prng(SEED + b"timing")
    winner, reason = None, None
    forced_timeout_done = False
    while True:
        p = order[turn % len(order)]
        turn += 1
        action, new_board = bot_turn(board, racks[p], opened[p])
        force_timeout = p == "p2" and not forced_timeout_done
        if force_timeout:
            # The sample stages an incomplete draft (draft recording is off), then lets its clock expire.
            action, new_board = "draw", None
        think = 4000 + timer.below(50000) if p not in COMPUTERS else 650
        if action == "play":
            ok, why, played, opening_points = validate_turn(board, new_board, racks[p], opened[p])
            assert ok, (turn, why)
            at += think
            ev = {"type": "turn", "n": turn, "player": p, "action": "play", "reason": "player", "board": new_board, "played": played}
            if not opened[p]:
                ev["opening"] = {"points": opening_points}
            racks[p] = [t for t in racks[p] if t not in set(played)]
            opened[p] = True
            board = new_board
            empty_draws = 0
            emit(ev)
            if not racks[p]:
                winner, reason = p, "out"
                break
        else:
            turn_reason = "player"
            if force_timeout:
                # Illustrate a timed-out incomplete draft: it is discarded and Bo draws three.
                turn_reason = "timeout"
                forced_timeout_done = True
                at += TURN_MS
            else:
                at += think
            if pool:
                draw_count = 3 if turn_reason == "timeout" else 1
                tiles = [pool.pop() for _ in range(min(draw_count, len(pool)))]
                racks[p].extend(tiles)
                empty_draws = 0
                private = {"tile": tiles[0]} if len(tiles) == 1 else {"tiles": tiles}
                emit({"type": "turn", "n": turn, "player": p, "action": "draw", "reason": turn_reason, "drew": len(tiles)}, private=private)
            else:
                empty_draws += 1
                emit({"type": "turn", "n": turn, "player": p, "action": "draw", "reason": turn_reason, "drew": 0})
                if empty_draws >= len(order):
                    reason = "blocked"
                    break
        if turn > 400:
            raise RuntimeError("runaway game")

    at += 300
    scores = {}
    if reason == "out":
        total = 0
        for q in order:
            if q == winner:
                continue
            pen = rack_penalty(racks[q])
            scores[q] = -pen
            total += pen
        scores[winner] = total
    else:
        pens = sorted(((rack_penalty(racks[q]), i, q) for i, q in enumerate(order)))
        best = pens[0][0]
        winner = pens[0][2]
        total = 0
        for pen, _, q in pens:
            if q == winner:
                continue
            scores[q] = -(pen - best)
            total += pen - best
        scores[winner] = total
    emit({"type": "end", "reason": reason, "winner": winner, "scores": scores, "racks": {q: list(racks[q]) for q in order}})

    unlock = {str(e["seq"]): e["private"] for e in events if "private" in e}
    at += 50
    emit({"type": "reveal", "seed": SEED.hex(), "algorithm": "fy-sha256-highest/1", "unlock": unlock})

    # hash chain over public projections
    prev = None
    for e in events:
        e["prev"] = prev
        e["hash"] = event_hash(e)
        prev = e["hash"]
    return events, order


# ---------- annotations ----------

def add_annotations(events):
    turns = [e for e in events if e["type"] == "turn"]
    timeout = next(e for e in turns if e["reason"] == "timeout")
    end = next(e for e in events if e["type"] == "end")
    last_at = events[-1]["at"]
    base = last_at + 3_600_000
    out = []
    # the first opening that laid more than one set gets a quieter alternative line
    board = []
    for e in turns:
        if e["action"] == "play" and "opening" in e:
            added = [m for m in e["board"] if all(t in set(e["played"]) for t in m)]
            if len(added) >= 2:
                best = max(added, key=lambda m: validate_set(m)[1])
                pts = validate_set(best)[1]
                if pts >= OPENING_MINIMUM:
                    alt_board = [list(m) for m in board] + [best]
                    out.append({
                        "type": "note", "id": "n-4f2e91", "at": base, "by": {"name": NAMES[e["player"]]},
                        "on": {"n": e["n"]},
                        "marks": ["!?"],
                        "text": f"Big opening ({e['opening']['points']}) that spends the wilcard on turn {e['n']} — but every 30+ opening from this rack needs it.",
                    })
                    out.append({
                        "type": "line", "id": "l-c31d5a", "at": base + 120_000, "by": {"name": NAMES[e["player"]]},
                        "on": {"n": e["n"]},
                        "text": f"The other way to open: just this set for {pts}, holding the coral run back to extend later.",
                        "moves": [{"player": e["player"], "action": "play", "board": alt_board}],
                    })
                    break
        if e["action"] == "play":
            board = e["board"]
    out.append({
        "type": "note", "id": "n-8a1c07", "at": base + 60_000, "by": {"name": "Bo"},
        "on": {"n": timeout["n"]},
        "marks": ["?"],
        "text": "Lost this turn to the clock while hunting for a rearrangement that was never there.",
    })
    out.append({
        "type": "eval", "id": "e-0d77b3", "at": base + 180_000,
        "by": {"tool": "guppycube-review", "version": "0.1.0"},
        "on": {"n": turns[-1]["n"]},
        "facts": {"rackValue": {p: rack_penalty(r) for p, r in end["racks"].items()}},
    })
    out.append({
        "type": "note", "id": "n-b02e44", "at": base + 240_000, "by": {"name": "Ada"},
        "text": "Worth replaying for the opening wilcard group.",
    })
    return out


# ---------- transcript ----------

def set_text(set):
    return "[" + " ".join(loose(t) for t in set) + "]"


def board_delta(prev, new):
    prev_keys = [tuple(sorted(loose(t) for t in m)) for m in prev]
    new_keys = [tuple(sorted(loose(t) for t in m)) for m in new]
    removed, added = [], []
    remaining = list(new_keys)
    for m, k in zip(prev, prev_keys):
        if k in remaining:
            remaining.remove(k)
        else:
            removed.append(m)
    remaining = list(prev_keys)
    for m, k in zip(new, new_keys):
        if k in remaining:
            remaining.remove(k)
        else:
            added.append(m)
    return removed, added


def transcript(events, annotations):
    header = next(e for e in events if e["type"] == "game")
    seats = [e for e in events if e["type"] == "seat"]
    start = next(e for e in events if e["type"] == "start")
    end = next((e for e in events if e["type"] == "end"), None)
    names = {s["player"]["id"]: s["player"]["name"] for s in seats}
    lines = []
    lines.append('[Format "guppycube-transcript/1"]')
    lines.append(f'[Record "{header["record"]["id"]}"]')
    lines.append(f'[Table "{header["record"]["table"]}"]')
    lines.append(f'[Origin "{header["record"]["origin"]}"]')
    lines.append(f'[Mode "{header["game"]["mode"]}"]')
    lines.append('[Seats "' + ", ".join(names[s["player"]["id"]] + (" (computer)" if s["player"]["kind"] == "computer" else "") for s in seats) + '"]')
    lines.append('[Order "' + ", ".join(names[p] for p in start["order"]) + '"]')
    lines.append(f'[ShuffleCommit "{start["shuffleCommit"]}"]')
    if end:
        score_text = ", ".join(f"{names[p]} {'+' if v > 0 else ''}{v}" for p, v in sorted(end["scores"].items(), key=lambda kv: -kv[1]))
        how = "went out" if end["reason"] == "out" else "won the blocked game"
        lines.append(f'[Result "{names[end["winner"]]} {how}; {score_text}"]')
    for a in annotations:
        if a["type"] == "note" and "on" not in a:
            lines.append(f'{{{a["by"].get("name", "?")}: {a["text"]}}}')
    deals = [e for e in events if e["type"] == "deal" and "private" in e]
    if deals:
        lines.append("")
        for d in deals:
            lines.append(f'Deal {names[d["player"]]}: ' + " ".join(loose(t) for t in d["private"]["rack"]))
    lines.append("")
    by_turn = defaultdict(list)
    for a in annotations:
        if "on" in a and "n" in a["on"]:
            by_turn[a["on"]["n"]].append(a)

    def delta_text(before, after):
        removed, added = board_delta(before, after)
        return " ".join(["-" + set_text(m) for m in removed] + ["+" + set_text(m) for m in added])

    board = []
    for e in events:
        if e["type"] != "turn":
            continue
        name = names[e["player"]]
        before = board
        if e["action"] == "draw":
            verb = "passes" if e["drew"] == 0 else "draws"
            if "private" in e:
                drawn = [e["private"]["tile"]] if e["drew"] == 1 else e["private"]["tiles"]
                verb += " " + " ".join(loose(tile) for tile in drawn)
            if e["reason"] == "timeout":
                verb += " (timeout)"
            elif e["reason"] == "auto-draw":
                verb += " (auto)"
            text = f'{e["n"]}. {name} {verb}'
        else:
            if "opening" in e:
                head = f'{name} opens {e["opening"]["points"]}'
            elif e.get("_out"):
                head = f"{name} out"
            else:
                head = name
            if e["reason"] == "timeout":
                head += " (timeout)"
            text = f'{e["n"]}. {head}: {delta_text(before, e["board"])}'
            board = e["board"]
        for a in by_turn.get(e["n"], []):
            who = a["by"].get("name") or a["by"].get("tool", "?")
            if a["type"] == "note":
                marks = "".join(a.get("marks", []))
                text += (f" {marks}" if marks else "") + f" {{{who}: {a['text']}}}"
            elif a["type"] == "line":
                parts = []
                b = before
                for i, mv in enumerate(a["moves"]):
                    if mv["action"] == "draw":
                        parts.append(f'{e["n"] + i}. {names[mv["player"]]} draws')
                    else:
                        parts.append(f'{e["n"] + i}. {names[mv["player"]]}: {delta_text(b, mv["board"])}')
                        b = mv["board"]
                text += f" ( {' '.join(parts)} {{{who}: {a['text']}}} )"
            elif a["type"] == "eval":
                text += f" {{{who}: {canonical_json(a['facts'])}}}"
        lines.append(text)
    if end:
        lines.append("")
        for p, rack in end["racks"].items():
            if rack:
                lines.append(f'Left on rack {names[p]}: ' + " ".join(loose(t) for t in rack) + f" ({rack_penalty(rack)})")
    return "\n".join(lines) + "\n"


def main(out_dir: str):
    events, order = simulate()
    # mark going-out turn for transcript rendering
    end = next(e for e in events if e["type"] == "end")
    if end["reason"] == "out":
        last_turn = [e for e in events if e["type"] == "turn"][-1]
        last_turn["_out"] = True
    annotations = add_annotations(events)
    text = transcript(events, annotations)
    for e in events:
        e.pop("_out", None)

    full_path = f"{out_dir}/sample-game.guppycube.jsonl"
    with open(full_path, "w") as f:
        for e in events + annotations:
            f.write(canonical_json(e) + "\n")
    # what seat p1 saw during play (before end/reveal): own private data only
    seat_path = f"{out_dir}/sample-game.seat-ada.during-play.jsonl"
    with open(seat_path, "w") as f:
        for e in events:
            if e["type"] in ("end", "reveal"):
                break
            f.write(canonical_json(project(e, "p1", COMPUTERS)) + "\n")
    with open(f"{out_dir}/sample-game.transcript.txt", "w") as f:
        f.write(text)
    turns = [e for e in events if e["type"] == "turn"]
    print(f"events={len(events)} turns={len(turns)} end={end['reason']} winner={NAMES[end['winner']]} scores={end['scores']}")
    print(f"bytes full={sum(len(canonical_json(e)) + 1 for e in events + annotations)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
