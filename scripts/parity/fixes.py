"""The documented, intentional changes the TypeScript port makes to the Python
answer logic, applied to the Python code as patches so the "fixed" golden
outputs still come from the Python implementation.

A. Sparse hours (bot_answer._best_hours / _worst_hour): ignore hours whose
   sample count is under 10% of the ride's busiest hour. Those are after-close
   stragglers (Flight of Passage: 17-19 stale "30 min" readings at 8-9 PM vs
   ~920 at midday). They were picked as the "shortest waits" and their tiny
   sample count capped the fact quality at 0.6, so time-of-day questions
   ("Flight of Passage wait in the afternoon") scored 0.66 and stayed silent.
B. Ride order ("which ride first", compare_rides): use the opening-rush
   15-minute profile (cell 4 = first 15 min after the official open, cell 12 =
   2 h later), day type weekday/weekend from the date, falling back to "all",
   then to the old hour-of-day method. Per park group, every ride uses the same
   source: rush only when every ride in the group has both cells.
"""
from __future__ import annotations

import math
from typing import Any, Optional

from app.services import bot_answer as ba
from app.services import bot_parse as bp

SPARSE_FRACTION = 0.1
RUSH_OPEN, RUSH_LATER = 4, 12
RUSH_WINDOW_DAYS = 60
_orig_open_vs_later = ba._ride_open_vs_later


def _dense(hourly):
    if not hourly:
        return hourly
    peak = max(n for _a, n in hourly.values())
    floor = max(ba._MIN_HOUR_SAMPLES, math.ceil(SPARSE_FRACTION * peak))
    return {h: v for h, v in hourly.items() if v[1] >= floor}


def _best_hours(hourly, k=2):
    return _orig_best(_dense(hourly), k)


def _worst_hour(hourly):
    return _orig_worst(_dense(hourly))


_orig_best, _orig_worst = ba._best_hours, ba._worst_hour

RUSH_LOOKUP = {}   # entity_id -> rush dict (filled by the harness from the bundle)


def _rush_cells(eid: str, day_type: str):
    r = RUSH_LOOKUP.get(eid) or {}
    cells = (r.get("open") or {}).get(day_type) or []
    if len(cells) <= RUSH_LATER:
        return None
    a, b = cells[RUSH_OPEN], cells[RUSH_LATER]
    if not a or not b:
        return None
    return a, b


_DT_LABEL = {"weekday": "on a typical weekday", "weekend": "on a typical weekend day", "all": "on a typical day"}


def facts_compare_rides(db, pq):
    day = pq.dates[0] if pq.date_explicit and pq.dates else None
    rides = pq.rides[:bp.MAX_COMPARE_RIDES]
    groups: dict = {}
    for r in rides:
        groups.setdefault(r.park_slug or "", []).append(r)
    if pq.park_source in ("explicit", "context") and len(groups.get(pq.park_slug or "", [])) >= 2:
        groups = {pq.park_slug: groups[pq.park_slug]}
    out: dict[str, Any] = {"type": "compare_rides", "units": "minutes of posted standby wait (historical averages)",
                           "data_basis": ("typical " + ba._DAY_NAMES[day.weekday()] + " pattern, last 90 days")
                           if day else "typical pattern across all days, last 90 days", "parks": []}
    if day:
        out["day"] = ba.fmt_day(day)
    qs = []
    rush_types = set()
    for park, grp in groups.items():
        if len(grp) < 2 or not park:
            continue
        rows, missing = [], []
        tried = ([("weekend" if day.weekday() >= 5 else "weekday")] if day else []) + ["all"]
        dt_used = None
        for dt in tried:
            cells = [_rush_cells(r.entity_id, dt) for r in grp]
            if all(cells):
                dt_used = dt
                for r, c in zip(grp, cells):
                    (a, na), (b, nb) = c
                    rows.append({"ride": r.name, "at_open": {"time": "opening", "avg_wait_min": a},
                                 "later": {"time": "2 hours after opening", "avg_wait_min": b},
                                 "climb_min": b - a, "_samples": na + nb, "_basis": "rush:" + dt})
                break
        if dt_used is None:
            for r in grp:
                row = _orig_open_vs_later(db, r, park, day, pq.destination)
                (rows if row else missing).append(row or r.name)
        else:
            rush_types.add(dt_used)
        if len(rows) < 2:
            continue
        ranked = sorted(rows, key=lambda x: -x["climb_min"])
        entry: dict[str, Any] = {"park": bp.park_display_name(pq.destination, park),
                                 "rides": [{k: v for k, v in x.items() if not k.startswith("_")} for x in rows]}
        top = ranked[0]["climb_min"]
        if top >= 10:
            first = [x["ride"] for x in ranked if x["climb_min"] >= top - 5]
            if len(first) < len(ranked):
                entry["do_first"] = first
                entry["later"] = [x["ride"] for x in ranked if x["ride"] not in first]
        else:
            entry["steady"] = True
        if missing:
            entry["no_data"] = missing
        q = min(ba._sample_quality(x["_samples"]) for x in rows)
        if entry.get("steady"):
            q = min(q, 0.6)
        if day and any(x["_basis"] not in ("dow_hour", "rush:weekday", "rush:weekend") for x in rows):
            q = min(q, 0.85)
        if missing:
            q *= 0.9
        qs.append(q)
        out["parks"].append(entry)
    if rush_types:
        dt = sorted(rush_types)[0] if len(rush_types) == 1 else "all"
        out["units"] = "minutes of posted standby wait (median, first 15 min after the official opening vs 2 h later)"
        out["data_basis"] = f"opening-rush profile, {dt} days, last {RUSH_WINDOW_DAYS} days"
        out["lead"] = f"Over the last {RUSH_WINDOW_DAYS} days {_DT_LABEL[dt]}"
    out["_quality"] = min(qs) if qs else 0.0
    return out


_orig_compare_text = ba._compare_text


def _compare_text(facts):
    s = _orig_compare_text(facts)
    lead = facts.get("lead")
    if lead:
        day = facts.get("day")
        old = f"Historically on a typical {day.split(',')[0]}" if day else "Historically"
        if s.startswith(old + ", "):
            s = lead + ", " + s[len(old) + 2:]
    return s


def install(rush_lookup: dict) -> None:
    RUSH_LOOKUP.clear()
    RUSH_LOOKUP.update(rush_lookup)
    ba._best_hours = _best_hours
    ba._worst_hour = _worst_hour
    ba.facts_compare_rides = facts_compare_rides
    ba._compare_text = _compare_text
