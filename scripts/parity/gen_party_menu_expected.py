#!/usr/bin/env python3
"""Golden data for the party + menu-item answers (src/bot/party.ts, src/bot/menuItems.ts).

Builds the bundle's `parties` and `menu_items` files with the backend exporter
(scripts/export_bot_bundle.py) and records what the backend itself answers
(app/services/bot_answer.answer_question) for the same data, so the TypeScript
port can be checked line for line. Two modes:

  fixture  the backend's own unit-test data (tests/test_special_events.py capture
           fixtures, tests/test_bot_menu.py seeded rows), "today" = 2026-10-26
  prod     the live database (plain SELECTs only), "today" = park-local today;
           menu_items is trimmed to the stands the questions match

Needs a checkout of the (private) RopeDrop backend:

  cd <backend checkout> && PYTHONPATH=. python <this dir>/gen_party_menu_expected.py \
      fixture <bot repo>/test/fixtures/party_menu/fixture
  cd <backend checkout> && DATABASE_URL=... PYTHONPATH=. python <this dir>/gen_party_menu_expected.py \
      prod <bot repo>/test/fixtures/party_menu/prod
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

PARTY_QUESTIONS = [
    "When and where can I meet Powerline Max in December?",
    "What nights is the Very Merry party in December?",
    "Is Jollywood Nights worth it?",
    "what time does the parade start at the Christmas party",
    "What nights is Jollywood Nights in December?",
    "When are the fireworks at Jollywood Nights?",
    "Which Very Merry Christmas Party nights are sold out?",
    "How much are Jollywood Nights tickets?",
    "What rides are open at the Very Merry party?",
    "What treats are at the Very Merry party?",
    "What time does Jollywood Nights start?",
    "Can I meet Max at Disney World?",
    "When is the Oogie Boogie Bash?",
]
MENU_QUESTIONS = [
    "What flavors of Dole whip are available at Disney World?",
    "Where can I get a Dole Whip at Disneyland?",
    "Is the Mickey pretzel still at Magic Kingdom?",
    "How much is a Dole Whip at Disney World?",
    "Where can I get a lemon Dole Whip at Disney World?",
    "Where can I get a Dole Whip?",
    "How much is a churro at EPCOT?",
    "what dole whip flavors are at MK",
    "Where can I get a churro at Disneyland?",
    "Do they still sell the turkey leg at Magic Kingdom?",
]
MENU_TOKENS = ("dole whip", "churro", "pretzel", "turkey leg")


def answers(db, questions, now, today):
    from app.services import bot_answer, bot_menu
    out = []
    for q in questions:
        bot_answer.clear_cache()
        bot_menu.clear_cache()
        r = bot_answer.answer_question(db, q, now_utc=now, today=today)
        out.append({"q": q, "intent": r["intent"], "confidence": r["confidence"],
                    "answer": r["answer"] if r["confidence"] > 0.1 else "",
                    "links": [l["url"] for l in r.get("links") or []]})
    return out


def export(db, now, dests=("wdw", "dlr")):
    sys.path.insert(0, "scripts")
    import export_bot_bundle as ebb
    ex = ebb.Exporter(db, now, log=lambda *_: None)
    files = {}
    for d in dests:
        files[f"{d}.parties.json"] = ex._parties(d)
        mi = ex._menu_items(d) or []
        files[f"{d}.menu_items.json"] = mi[0] if len(mi) == 1 else _merge_parts(mi)
    return files


def _merge_parts(parts):
    if not parts:
        return None
    out = dict(parts[0], part=1, parts=1, stands={})
    for p in parts:
        out["stands"].update(p["stands"])
    return out


def trim_menu(doc):
    """Only stands with an item the questions can match (status was computed on the full data)."""
    if not doc:
        return doc
    def hit(name):
        n = name.lower().replace("®", "")
        return any(t in n for t in MENU_TOKENS) or ("mickey" in n and "pretzel" in n)
    keep = {}
    for rid, s in doc["stands"].items():
        items = [it for it in s["items"] if hit(it[0])]
        if items:
            keep[rid] = dict(s, items=items)
    return dict(doc, stands=keep)


def fixture_mode(out: Path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from app.models import Base, Entity, MenuItem, Restaurant
    from app.services import menu_pages
    sys.path.insert(0, ".")
    import tests.test_bot_menu as TM
    import tests.test_special_events as TS

    now, today = TS.NOW_UTC, TS.TODAY
    # one DB with both the party capture and the menu rows
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()
    f = TS.C.Fetcher(gap=0, opener=TS._opener(TS.ROUTES))
    TS.C.store(db, TS.C.capture_destination("wdw", f, today, horizon_days=60), now=datetime(2026, 10, 26, 14, 0))
    for rid, name, park_id, ent in TM.STANDS:
        if ent:
            eid, slug, dest, park = ent
            db.add(Entity(id=eid, name=name, entity_type="RESTAURANT", slug=slug, destination=dest, park=park,
                          location_category=park_id))
        db.add(Restaurant(id=rid, name=name, park_id=park_id, entity_id=ent[0] if ent else None))
    db.commit()
    for rid, name, price, period, seen, hidden in TM.ITEMS:
        db.add(MenuItem(restaurant_id=rid, name=name, price=price, meal_period=period, last_seen=seen,
                        first_seen=seen, hidden_at=hidden))
    db.commit()
    menu_pages.clear_menu_index_cache()
    write(out, export(db, now), answers(db, PARTY_QUESTIONS + MENU_QUESTIONS, now, today), now, today)


def prod_mode(out: Path):
    from app.database import SessionLocal
    from app.services.bot_parse import local_today
    now = datetime.now(timezone.utc)
    today = local_today("wdw", now)
    db = SessionLocal()
    try:
        files = export(db, now)
        for k in list(files):
            if k.endswith("menu_items.json"):
                files[k] = trim_menu(files[k])
        cases = answers(db, PARTY_QUESTIONS + MENU_QUESTIONS, now, today)
    finally:
        db.close()
    write(out, files, cases, now, today)


def write(out: Path, files, cases, now, today):
    out.mkdir(parents=True, exist_ok=True)
    for name, doc in files.items():
        if doc:
            (out / name).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":"), default=str) + "\n")
    (out / "expected.json").write_text(json.dumps(
        {"now": now.isoformat(), "today": today.isoformat(), "cases": cases}, ensure_ascii=False, indent=1) + "\n")
    print(f"wrote {out}: {sorted(files)} + expected.json ({len(cases)} cases)")


if __name__ == "__main__":
    mode, dest_dir = sys.argv[1], Path(sys.argv[2])
    (fixture_mode if mode == "fixture" else prod_mode)(dest_dir)
