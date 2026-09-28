#!/usr/bin/env python3
"""Golden outputs for the TypeScript parity tests.

Runs the 29 fixture posts (backend scripts/bot_eval_posts.POSTS) through the
CURRENT Python pipeline (app/services/bot_answer.analyze_post) with every data
read served from a frozen bot bundle (bundle_backend.py), in two modes:
  legacy: the Python code as-is
  fixed:  + the documented fixes (fixes.py)
Writes {"posts": [{id, text, legacy, fixed}]} as JSON to stdout. Needs a
checkout of the (private) RopeDrop backend for the Python modules:

  cd <backend checkout> && PYTHONPATH=.:<this dir> \
    python <this dir>/gen_expected.py <bot repo>/test/fixtures/bundle > parity_expected.json
"""
import json
import sys
from datetime import date, datetime, timezone

import bundle_backend as bb

TODAY = date(2026, 9, 28)
NOW = datetime(2026, 9, 28, 18, 0, tzinfo=timezone.utc)
THRESHOLD = 0.7


def run(posts):
    from app.services import bot_answer as ba
    out = {}
    for post in posts:
        res = ba.analyze_post(None, post["text"], now_utc=NOW, today=TODAY, threshold=THRESHOLD)
        out[post["id"]] = {
            "reply": res["confidence"] >= THRESHOLD,
            "confidence": res["confidence"],
            "intent": res["intent"],
            "answer": res["answer"],
            "links": [l["url"] for l in res.get("links", [])],
            "parts": [{"intent": p["intent"], "confidence": p["confidence"], "answer": p["answer"],
                       "rides": [r.name for r in p["pq"].rides], "parks": list(p["pq"].parks),
                       "dates": [d.isoformat() for d in p["pq"].dates] if p["pq"].date_explicit else [],
                       "destination": p["pq"].destination,
                       "links": [l["url"] for l in p["links"]]} for p in res.get("parts", [])],
        }
    return out


def main():
    bb.load(sys.argv[1])
    bb.install()
    sys.path.insert(0, "scripts")
    from bot_eval_posts import POSTS
    legacy = run(POSTS)
    import fixes
    rush = {eid: r["rush"] for d in ("wdw", "dlr") for eid, r in bb._B[d]["rides"].items() if r.get("rush")}
    fixes.install(rush)
    fixed = run(POSTS)
    json.dump({"generated_with": {"today": TODAY.isoformat(), "now_utc": NOW.isoformat(), "threshold": THRESHOLD},
               "posts": [{"id": p["id"], "text": p["text"], "legacy": legacy[p["id"]], "fixed": fixed[p["id"]]}
                         for p in POSTS]},
              sys.stdout, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
