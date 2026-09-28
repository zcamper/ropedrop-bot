"""Run the CURRENT Python Reddit-bot pipeline (app.services.bot_parse /
bot_answer / bot_summary) against a frozen bot bundle instead of the database.

Every DB/engine read the bot makes is replaced by a read of the same value
from the bundle (the exporter produced the bundle from exactly those reads),
so the Python output is the golden reference for the TypeScript port.
Live waits: the bundle has none, so live_snapshot() returns None (same as a
stale/unavailable live cache on the server).
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path

from app.services import bot_answer as ba
from app.services import bot_parse as bp

_B: dict = {}
_LAST_OUTLOOK: dict = {}


def _read(root: Path, rel: str) -> dict:
    p = root / rel
    gz = Path(str(p) + ".gz")
    if gz.exists():
        return json.loads(gzip.decompress(gz.read_bytes()))
    return json.loads(p.read_text())


def load(bundle_dir: str) -> None:
    """A bundle laid out like the bucket: manifest.json + g/<generation>/...
    (files may be gzipped, as in test/fixtures/bundle)."""
    root = Path(bundle_dir)
    m = json.loads((root / "manifest.json").read_text())
    _B["common"] = _read(root, m["common"])
    for d, info in m["destinations"].items():
        _B[d] = _read(root, info["files"]["core"])


def _core(dest):
    return _B[dest]


def _ride(eid):
    for d in ("wdw", "dlr", "dlp", "tdr", "hkdl", "shdr"):
        r = _B.get(d, {}).get("rides", {}).get(eid)
        if r:
            return r
    return None


def _load_attractions(db, destination):
    return [{"id": eid, "name": r["name"], "norm": r["norm"], "variants": r["variants"],
             "slug": r["slug"], "park_slug": r["park"]}
            for eid, r in _core(destination)["rides"].items()]


def ride_hourly(db, entity_id, dow):
    r = _ride(entity_id) or {}
    w = r.get("waits") or {}
    if dow is not None and w.get("dow_hour"):
        row = w["dow_hour"][dow]
        data = {h: (c[0], c[1]) for h, c in enumerate(row) if c}
        if data:
            return data, "dow_hour"
    return {h: (c[0], c[1]) for h, c in enumerate(w.get("hour") or []) if c}, "hour"


def ride_dow(db, entity_id):
    w = (_ride(entity_id) or {}).get("waits") or {}
    return {d: (c[0], c[1]) for d, c in enumerate(w.get("dow") or []) if c}


def has_wait_data(db, entity_id):
    w = (_ride(entity_id) or {}).get("waits") or {}
    return any(w.get("hour") or [])


def _outlook(dest, park, day):
    days = _core(dest)["outlook"].get(park, {}).get("days", {})
    e = days.get(day.isoformat())
    if e is None:
        e = next((v for v in days.values() if v["weekday"] == day.weekday()), None)
    return e


def get_strategy(db, destination, park_slug, target_date):
    e = _outlook(destination, park_slug, target_date)
    _LAST_OUTLOOK["e"] = e
    if not e:
        return {}

    def pick(x):
        return {"name": x["ride"], "rope_drop_wait": x["avg_wait_at_open_min"],
                "peak_wait": x["typical_peak_wait_min"], "net_time_saved": x["minutes_saved_vs_peak"]}
    s = {"rope_drop_pick": {"official": [pick(x) for x in e["rope_drop"]],
                            "etpe": [pick(x) for x in e["early_entry_picks"]]}}
    if e.get("peak"):
        pk = e["peak"]
        s["peak_hours"] = {"peak_window": {"start_label": pk["start"], "end_label": pk["end"],
                                           "start_hour": pk["start_hour"], "end_hour": pk["end_hour"],
                                           "avg_wait": pk["avg_headliner_wait_min"]},
                           "hourly_breakdown": [{"hour": 0}]}
    return s


def quieter_window(hourly_breakdown, open_hour, close_hour, peak):
    e = _LAST_OUTLOOK.get("e") or {}
    q = e.get("quieter")
    if not q:
        return None
    return {"start": q["start"], "end": q["end"], "avg_headliner_wait_min": q["avg_headliner_wait_min"],
            "_start_hour": q["start_hour"]}


def get_crowd(db, destination, park_slug, target_date):
    c = _core(destination)["crowds"].get(park_slug, {}).get("days", {}).get(target_date.isoformat())
    if not c:
        return None
    return {"crowd_level": c["level"], "label": c["label"], "predicted_avg_wait_min": c["avg_wait"],
            "model_confidence": c["confidence"], "seasonal_periods": c["seasonal"]}


def get_hours(db, park_slug, target_date):
    for d in ("wdw", "dlr", "dlp", "tdr", "hkdl", "shdr"):
        ph = _B.get(d, {}).get("hours", {}).get(park_slug)
        if ph is not None:
            h = ph["days"].get(target_date.isoformat())
            break
    else:
        h = None
    if not h:
        return None
    out = {"open": h.get("open"), "close": h.get("close"),
           "early_entry": ({"open": h["early_entry"]["open"], "close": h["early_entry"]["close"]}
                           if h.get("early_entry") else None),
           "extended_evening": ({"open": h["extended_evening"]["open"], "close": h["extended_evening"]["close"]}
                                if h.get("extended_evening") else None),
           "special_events": [{"name": x["name"], "open": x.get("open"), "close": x.get("close")}
                              for x in h.get("extras") or []]}
    if h.get("open24"):
        out["_open_hour"] = int(h["open24"][:2])
    if h.get("close24"):
        out["_close_hour"] = int(h["close24"][:2])
    if not out["open"] and not out["early_entry"] and not out["special_events"]:
        return None
    return out


def install() -> None:
    bp._load_attractions = _load_attractions
    ba.ride_hourly = ride_hourly
    ba.ride_dow = ride_dow
    ba.has_wait_data = has_wait_data
    ba.live_snapshot = lambda destination, park_slug: None
    ba.get_strategy = get_strategy
    ba.quieter_window = quieter_window
    ba.get_crowd = get_crowd
    ba.get_hours = get_hours
    ba.COMPOSER = None
    # bot_summary imported these via the module, so the patches apply there too.
