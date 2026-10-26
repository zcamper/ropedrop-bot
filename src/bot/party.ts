// Ticketed parties / After Hours answers (intent "party"), ported from the
// RopeDrop backend's bot_parse.detect_party / party_topics, bot_party.py and
// special_events_facts.py (2026-10-26). Facts come only from the bundle's
// parties.json (Disney's own event pages, ticket pages and ticketed-night
// schedules, captured twice a day): nothing captured for what was asked ->
// quality 0 -> silent. Facts only: "is it worth it?" gets what Disney lists.
//
// Differences from the backend (documented, tested):
//  * every answer ends with the capture date ("From Disney's event pages as
//    of Oct 26."), because the bundle is nightly;
//  * links only to event pages the site has (the backend also links event
//    kinds whose page 404s);
//  * the content guard is the bundle's closed-attractions list (the backend
//    runs the full fact_guard); numbers are checked by answer.ts's guard.

import type { AnswerEnv, Facts, Link } from './answer.js';
import type { ParsedQuestion } from './parse.js';
import { hasPhrase, normalize } from './text.js';
import type { Common, Dest, Parties, PartyEvent } from './types.js';
import {
  isoDay,
  monthAbbr,
  parseIsoDay,
  shortIso,
  weekday,
  WEEKDAY_NAMES,
  ymd,
} from './util.js';

// ---------------------------------------------------------------- parse (bot_parse)

/** (aliases, destination, special_events slug). Checked longest alias first. */
const PARTY_ALIAS_SOURCE: [string[], Dest, string][] = [
  [
    [
      'very merry',
      'very merry christmas party',
      'mickeys very merry christmas party',
      'mvmcp',
      'very merry party',
      'very merriest',
      'christmas party',
      'mickeys christmas party',
      'merry party',
    ],
    'wdw',
    'mickeys-very-merry-christmas-party',
  ],
  [
    [
      'jollywood',
      'jollywood nights',
      'jolly wood',
      'jolly wood nights',
      'disney jollywood nights',
      'jollywood party',
    ],
    'wdw',
    'jollywood-nights',
  ],
  [
    [
      'not so scary',
      'mnsshp',
      'not so scary halloween party',
      'mickeys not so scary halloween party',
    ],
    'wdw',
    'mickeys-not-so-scary-halloween-party',
  ],
  [
    ['oogie boogie bash', 'oogie boogie', 'oogie bash', 'obb'],
    'dlr',
    'oogie-boogie-bash-halloween-party',
  ],
  [['h2o glow', 'h2o glow after hours'], 'wdw', 'h2o-glow-after-hours'],
  [['disneyland after dark', 'after dark'], 'dlr', 'after-dark'],
];

/** Python: sorted(..., key=lambda x: -len(x[0])) is stable. */
export const PARTY_ALIASES: [string, Dest, string][] =
  PARTY_ALIAS_SOURCE.flatMap(([aliases, d, s]) =>
    aliases.map((a) => [normalize(a), d, s] as [string, Dest, string])
  )
    .map((x, i) => ({ x, i }))
    .sort((a, b) => b.x[0].length - a.x[0].length || a.i - b.i)
    .map((o) => o.x);

const AFTER_HOURS: Record<string, string> = {
  magic_kingdom: 'magic-kingdom-after-hours',
  hollywood_studios: 'hollywood-studios-after-hours',
  epcot: 'epcot-after-hours',
};

export const MEET_CUE =
  /\b(meet|meeting|meets|greet|greeting|greetings|characters?|meet and greet)\b/;

/** Topic -> pattern, in priority order (the first topic is the lead answer). */
const PARTY_TOPICS: [string, RegExp][] = [
  ['character', /\b(meet|meeting|meets|greet|greeting|characters?)\b/],
  ['parade', /\bparades?\b|\bcavalcade/],
  ['fireworks', /\bfireworks?\b|\bspectacular\b|\bjingle bam\b/],
  ['show', /\bshows?\b|\bsing ?along\b|\bstage\b/],
  [
    'price',
    /\b(price|prices|cost|costs|how much|expensive|cheap|cheapest|tickets?)\b/,
  ],
  [
    'dates',
    /\b(dates?|nights?|days?|which nights|what nights|when is|when are|schedule)\b/,
  ],
  [
    'times',
    /\b(what time|start|starts|begin|begins|end|ends|hours|how long|until|enter|entry)\b/,
  ],
  ['rides', /\b(rides?|attractions?|coasters?)\b/],
  ['treats', /\b(treats?|food|snacks?|cookies?|eat|drinks?|cocoa|candy)\b/],
  [
    'overview',
    /\b(worth|whats at|what is at|whats included|what is included|whats there|what do you get|what happens|anything|tell me about|what to expect|whats it like)\b/,
  ],
];

/** bot_parse.detect_party: [destination, slug] named in the question, or null. */
export function detectParty(
  norm: string,
  destination: Dest | null,
  parkSlug: string | null
): [Dest, string] | null {
  for (const [alias, d, slug] of PARTY_ALIASES) {
    if (hasPhrase(norm, alias)) {
      if (
        destination &&
        d !== destination &&
        (alias === 'christmas party' || alias === 'after dark')
      )
        continue;
      return [d, slug];
    }
  }
  if (hasPhrase(norm, 'halloween party')) {
    return destination === 'dlr'
      ? ['dlr', 'oogie-boogie-bash-halloween-party']
      : ['wdw', 'mickeys-not-so-scary-halloween-party'];
  }
  if (hasPhrase(norm, 'after hours') && parkSlug && AFTER_HOURS[parkSlug]) {
    return ['wdw', AFTER_HOURS[parkSlug] as string];
  }
  return null;
}

/** bot_parse.party_topics. */
export function partyTopics(normIn: string): string[] {
  // Drop the party's own name first ("Jollywood Nights" is not a dates question).
  let norm = ` ${normIn} `;
  const names = [
    ...PARTY_ALIASES.map((a) => a[0]),
    'halloween party',
    'after hours',
  ];
  for (const alias of names) norm = norm.split(` ${alias} `).join(' ');
  norm = norm.trim();
  let topics = PARTY_TOPICS.filter(([, re]) => re.test(norm)).map(([k]) => k);
  // "What time does the parade start" is about the parade, not the party's hours.
  if (
    topics.some((t) => ['parade', 'fireworks', 'show', 'character'].includes(t))
  ) {
    const datesRe =
      /\b(nights?|dates?|which|what) (nights?|dates?|days?)\b|\bin (january|february|march|april|may|june|july|august|september|october|november|december)\b/;
    topics = [
      ...topics.filter((t) => t !== 'times' && t !== 'dates'),
      ...topics.filter((t) => t === 'dates' && datesRe.test(norm)),
    ];
  }
  return topics.length ? topics : ['overview'];
}

// ---------------------------------------------------------------- facts (special_events_facts)

export const PARK_NAMES: Record<string, string> = {
  magic_kingdom: 'Magic Kingdom',
  epcot: 'EPCOT',
  hollywood_studios: 'Hollywood Studios',
  animal_kingdom: 'Animal Kingdom',
  typhoon_lagoon: 'Typhoon Lagoon',
  blizzard_beach: 'Blizzard Beach',
  disneyland: 'Disneyland Park',
  california_adventure: 'Disney California Adventure',
};
const PAGE_KINDS = ['party', 'after_hours'];
const SUPPORTED: Dest[] = ['wdw', 'dlr'];

/** Words that are part of character names but say nothing about who it is. */
const NAME_STOP = new Set(
  `a an and the as at of from in on or with dressed santa holiday disney pals
    friends characters character mr mrs ms new returning`.split(/\s+/)
);

export function timeLabel(hhmm: string | null | undefined): string | null {
  if (!hhmm || !/^\d\d:\d\d$/.test(hhmm)) return null;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3));
  if (h === 0 && m === 0) return 'midnight';
  if (h === 12 && m === 0) return 'noon';
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return m
    ? `${h12}:${String(m).padStart(2, '0')} ${suffix}`
    : `${h12} ${suffix}`;
}

function md(iso: string): { m: number; d: number; day: number } {
  const day = parseIsoDay(iso) as number;
  const { m, d } = ymd(day);
  return { m, d, day };
}

/** "Sat Dec 5". */
export function dayLabel(iso: string): string {
  const { m, d, day } = md(iso);
  return `${(WEEKDAY_NAMES[weekday(day)] as string).slice(0, 3)} ${monthAbbr(m)} ${d}`;
}

/** [Dec 5, Dec 7, Jan 3] -> "Dec 5, 7; Jan 3"; one month -> "Dec 5, 7 and 12". */
export function daysList(days: string[]): string {
  if (!days.length) return '';
  const parts: string[][] = [];
  let curM: number | null = null;
  let cur: string[] = [];
  for (const iso of [...days].sort()) {
    const { m, d } = md(iso);
    if (m !== curM) {
      if (cur.length) parts.push(cur);
      curM = m;
      cur = [`${monthAbbr(m)} ${d}`];
    } else {
      cur.push(String(d));
    }
  }
  parts.push(cur);
  const flat = parts.map((p) => p.join(', '));
  const first = parts[0] as string[];
  if (flat.length === 1 && first.length > 1) {
    return `${first.slice(0, -1).join(', ')} and ${first[first.length - 1]}`;
  }
  return flat.join('; ');
}

function nameTokens(name: string): Set<string> {
  return new Set(
    normalize(name)
      .split(' ')
      .filter((t) => t && !NAME_STOP.has(t) && t.length >= 3)
  );
}

/**
 * How well a question names someone in a Disney character listing (0 = no
 * match). Each person in "Edna Mode and Frozone" matches when the question
 * has at least half of their distinctive words, or one 6+ letter word.
 */
export function personMatch(listing: string, qTokens: Set<string>): number {
  let best = 0;
  for (const person of (listing ?? '').split(/\s+(?:and|or)\s+/)) {
    const toks = nameTokens(person);
    if (!toks.size) continue;
    const hit = [...toks].filter((t) => qTokens.has(t));
    if (
      hit.length &&
      (2 * hit.length >= toks.size || hit.some((t) => t.length >= 6))
    ) {
      best = Math.max(best, hit.length);
    }
  }
  return best;
}

type Window = [string, string] | null;

function nightsIn(ev: PartyEvent, start: string, end: string | null): string[] {
  return ev.nights
    .map((n) => n[0])
    .filter((d) => d >= start && (end === null || d <= end));
}

function sortKeyTime(t: string, partyStart: string | null): string {
  // Times after midnight sort after the evening ones.
  if (partyStart && t < '12:00' && '12:00' <= partyStart) return `2${t}`;
  return `1${t}`;
}

type SchedItem = {
  name: string;
  kind: string | null;
  times: { start: string; end: string | null }[];
  nights_with_pattern: string[];
  nights: string[];
  other_nights: number;
};

function scheduleByItem(
  ev: PartyEvent,
  shows: PartyEvent['showtimes']
): SchedItem[] {
  const per = new Map<
    string,
    {
      name: string;
      kind: string | null;
      nights: Map<string, [string, string | null][]>;
    }
  >();
  for (const [eid, name, kind, night, start, end] of shows) {
    let g = per.get(eid);
    if (!g) {
      g = { name, kind, nights: new Map() };
      per.set(eid, g);
    }
    const arr = g.nights.get(night) ?? [];
    arr.push([start, end]);
    g.nights.set(night, arr);
  }
  const pat = (v: [string, string | null][]) =>
    JSON.stringify(
      v
        .map((x, i) => ({ x, i, k: sortKeyTime(x[0], ev.start) }))
        .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
        .map((o) => o.x)
    );
  const out: SchedItem[] = [];
  for (const g of per.values()) {
    const counts = new Map<string, number>();
    for (const v of g.nights.values()) {
      const k = pat(v);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let common = '';
    let nCommon = -1;
    for (const [k, n] of counts) {
      if (n > nCommon) {
        common = k;
        nCommon = n;
      }
    }
    const times = (JSON.parse(common) as [string, string | null][]).map(
      ([start, end]) => ({ start, end })
    );
    out.push({
      name: g.name,
      kind: g.kind,
      times,
      nights_with_pattern: [...g.nights.entries()]
        .filter(([, v]) => pat(v) === common)
        .map(([n]) => n)
        .sort(),
      nights: [...g.nights.keys()].sort(),
      other_nights: g.nights.size - nCommon,
    });
  }
  const key = (x: SchedItem): [number, string] => [
    x.kind !== 'Entertainment' ? 1 : 0,
    sortKeyTime((x.times[0] as { start: string }).start, ev.start),
  ];
  return out
    .map((x, i) => ({ x, i, k: key(x) }))
    .sort(
      (a, b) =>
        a.k[0] - b.k[0] ||
        (a.k[1] < b.k[1] ? -1 : a.k[1] > b.k[1] ? 1 : 0) ||
        a.i - b.i
    )
    .map((o) => o.x);
}

type Offering = { name: string; location: string | null };

type Card = {
  name: string;
  park: string | null;
  start: string | null;
  end: string | null;
  early_entry: string | null;
  start_label: string | null;
  end_label: string | null;
  early_entry_label: string | null;
  price_min: number | null;
  price_max: number | null;
  status_note: string | null;
  nights: { date: string; label: string }[];
  sold_out_nights: string[];
  on_sale_adult_min: number | null;
  on_sale_adult_max: number | null;
  offerings: Record<string, Offering[]>;
  schedule: SchedItem[];
  schedule_nights: string[];
};

/** special_events_facts.event_card: upcoming nights only (or `window`). */
function eventCard(ev: PartyEvent, today: string, window: Window): Card {
  const [start, end] = window ?? [today, null];
  const nights = ev.nights.filter(
    (n) => n[0] >= start && (end === null || n[0] <= end)
  );
  const from = start > today ? start : today;
  const shows = ev.showtimes.filter(
    (s) => s[3] >= from && (end === null || s[3] <= end)
  );
  const byKind: Record<string, Offering[]> = {};
  for (const [kind, name, location] of ev.offerings) {
    (byKind[kind] ??= []).push({ name, location: location || null });
  }
  const onSale = nights
    .filter((n) => n[1] !== null && !n[3])
    .map((n) => n[1] as number);
  return {
    name: ev.name,
    park: ev.park ? (PARK_NAMES[ev.park] ?? null) : null,
    start: ev.start,
    end: ev.end,
    early_entry: ev.early_entry,
    start_label: timeLabel(ev.start),
    end_label: timeLabel(ev.end),
    early_entry_label: timeLabel(ev.early_entry),
    price_min: ev.price_min,
    price_max: ev.price_max,
    status_note: ev.status_note,
    nights: nights.map((n) => ({ date: n[0], label: dayLabel(n[0]) })),
    sold_out_nights: nights.filter((n) => n[3]).map((n) => n[0]),
    on_sale_adult_min: onSale.length ? Math.min(...onSale) : null,
    on_sale_adult_max: onSale.length ? Math.max(...onSale) : null,
    offerings: byKind,
    schedule: shows.length ? scheduleByItem(ev, shows) : [],
    schedule_nights: [...new Set(shows.map((s) => s[3]))].sort(),
  };
}

type CharHit = {
  slug: string;
  ev: PartyEvent;
  character: string;
  locations: string[];
  nights: string[];
  dest: Dest;
};

/** special_events_facts.find_party_characters. */
function findPartyCharacters(
  parties: Parties,
  dest: Dest,
  qn: string,
  slug: string | null,
  window: Window,
  today: string
): CharHit[] {
  const q = new Set(qn.split(' '));
  const out: CharHit[] = [];
  for (const [s, ev] of Object.entries(parties.events)) {
    if (slug && s !== slug) continue;
    if (!PAGE_KINDS.includes(ev.kind)) continue;
    const hits = new Map<
      string,
      { name: string; locations: string[]; score: number }
    >();
    for (const [kind, name, location] of ev.offerings) {
      if (kind !== 'character') continue;
      const score = personMatch(name, q);
      if (!score) continue;
      let h = hits.get(name);
      if (!h) {
        h = { name, locations: [], score };
        hits.set(name, h);
      }
      if (location && !h.locations.includes(location))
        h.locations.push(location);
    }
    if (!hits.size) continue;
    const [start, end] = window ?? [today, null];
    const nights = nightsIn(ev, start > today ? start : today, end);
    let best: { name: string; locations: string[]; score: number } | null =
      null;
    for (const h of hits.values()) if (!best || h.score > best.score) best = h;
    const b = best as { name: string; locations: string[] };
    out.push({
      slug: s,
      ev,
      character: b.name,
      locations: b.locations,
      nights,
      dest,
    });
  }
  return out;
}

function regularLocatorHas(parties: Parties, qn: string): boolean {
  const q = new Set(qn.split(' '));
  return (parties.regular_characters ?? []).some((n) => personMatch(n, q) > 0);
}

// ---------------------------------------------------------------- answers (bot_party)

const SHOW_KIND_RE: Record<string, RegExp> = {
  parade: /parade|cavalcade/i,
  fireworks: /firework|spectacular|jingle bam/i,
};

function money(v: number): string {
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

function timesText(times: { start: string; end: string | null }[]): string {
  const labels = times.map((t) => {
    const a = timeLabel(t.start);
    const b = t.end ? timeLabel(t.end) : null;
    return b ? `${a} to ${b}` : `${a}`;
  });
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function patternNote(item: SchedItem, lastNight: string | null): string {
  const mine = item.nights;
  const covered = item.nights_with_pattern;
  if (!mine.length) return '';
  const lo = mine[0] as string;
  const hi = mine[mine.length - 1] as string;
  const span =
    mine.length > 1 ? `${dayLabel(lo)} to ${dayLabel(hi)}` : dayLabel(lo);
  let note: string;
  if (covered.length === mine.length) {
    note =
      mine.length > 1
        ? `on all ${mine.length} nights with posted times (${span})`
        : `on ${span}`;
  } else {
    note = `on ${covered.length} of ${mine.length} nights with posted times (${span}; other nights differ)`;
  }
  if (lastNight && hi < lastNight) note += "; later nights aren't posted yet";
  return note;
}

type PartyCtx = {
  env: AnswerEnv;
  pq: ParsedQuestion;
  today: string;
  window: Window;
  wlabel: string | null;
};

function windowOf(pq: ParsedQuestion): [Window, string | null] {
  if (pq.dateExplicit && pq.dates.length) {
    const lo = Math.min(...pq.dates);
    const hi = Math.max(...pq.dates);
    return [[isoDay(lo), isoDay(hi)], pq.dateLabel];
  }
  return [null, null];
}

async function partiesFor(env: AnswerEnv, dest: Dest): Promise<Parties | null> {
  if (!env.src.parties) return null;
  try {
    return await env.src.parties(dest);
  } catch {
    return null;
  }
}

async function character(c: PartyCtx, out: Facts): Promise<Facts> {
  const { pq, today, window, wlabel } = c;
  const qn = pq.normalized;
  const dest = pq.destination;
  const own = await partiesFor(c.env, dest);
  if (!pq.partySlug && own && regularLocatorHas(own, qn)) {
    out.note = 'character also meets on regular days; not a party question';
    return out;
  }
  const dests = pq.destinationExplicit || pq.partySlug ? [dest] : SUPPORTED;
  let hits: CharHit[] = [];
  for (const d of dests) {
    const p = d === dest ? own : await partiesFor(c.env, d);
    if (p)
      hits.push(...findPartyCharacters(p, d, qn, pq.partySlug, window, today));
  }
  const withNights = hits.filter((h) => h.nights.length);
  if (withNights.length) hits = withNights;
  if (!hits.length) return out;
  const parts: string[] = [];
  const chars: Facts[] = [];
  for (const h of hits.slice(0, 2)) {
    const e = h.ev;
    const card = eventCard(e, today, window);
    const park = (e.park && PARK_NAMES[e.park]) || '';
    const where = h.locations.length ? `, at the ${h.locations[0]}` : '';
    let txt = `Disney lists ${h.character} at ${e.name}${park ? ` (${park})` : ''}${where}.`;
    const nights = h.nights;
    if (nights.length) {
      const lead = wlabel ? `${wlabel} party nights` : 'Upcoming party nights';
      txt += ` ${lead}: ${daysList(nights)}`;
      if (card.start_label && card.end_label)
        txt += `, ${card.start_label} to ${card.end_label}`;
      txt += '.';
      const sold = card.sold_out_nights.filter((n) => nights.includes(n));
      if (sold.length) txt += ` Sold out: ${daysList(sold)}.`;
    } else if (wlabel) {
      txt += ` No ${wlabel} nights are listed for it.`;
    }
    const q = new Set(qn.split(' '));
    const meets = card.schedule.filter(
      (it) => it.kind !== 'Attraction' && personMatch(it.name, q) > 0
    );
    if (meets.length) {
      const m0 = meets[0] as SchedItem;
      txt += ` Disney's schedule shows ${m0.name} ${timesText(m0.times)}.`;
    } else {
      txt +=
        " Disney doesn't post a meet time for it, and the party needs its own ticket.";
    }
    parts.push(txt);
    chars.push({
      character: h.character,
      event: e.name,
      park,
      locations: h.locations,
      nights: nights.map(dayLabel),
      nights_short: daysList(nights),
      start: card.start,
      end: card.end,
      sold_out: card.sold_out_nights.map(dayLabel),
      schedule: meets
        .slice(0, 1)
        .map((m) => ({ name: m.name, times: m.times })),
    });
    (out._slugs ??= []).push([h.dest, h.slug, e]);
  }
  out.characters = chars;
  out._answer = parts.join(' ');
  out._quality = hits.some((h) => h.nights.length) ? 1.0 : 0.75;
  return out;
}

async function partyFactsInner(c: PartyCtx, parties: Parties): Promise<Facts> {
  const { pq, today, window, wlabel } = c;
  const topic = pq.partyTopics[0] ?? 'overview';
  const out: Facts = { type: 'party', topic, _quality: 0.0 };
  const ev = pq.partySlug ? (parties.events[pq.partySlug] ?? null) : null;
  if (pq.partySlug && !ev) return out;
  if (topic === 'character') return character(c, out);
  if (!ev) return out;

  const card = eventCard(ev, today, window);
  out._slugs = [[pq.destination, pq.partySlug, ev]];
  const park = card.park;
  const head = `${ev.name}${park ? ` (${park})` : ''}`;
  const hours =
    card.start_label && card.end_label
      ? `${card.start_label} to ${card.end_label}`
      : '';
  const nights = card.nights.map((n) => n.date);
  const sold = card.sold_out_nights;
  Object.assign(out, {
    event: ev.name,
    park,
    start: card.start,
    end: card.end,
    early_entry: card.early_entry,
    price_min: card.price_min,
    price_max: card.price_max,
    on_sale_adult_min: card.on_sale_adult_min,
    on_sale_adult_max: card.on_sale_adult_max,
    nights: card.nights.map((n) => n.label),
    sold_out: sold.map(dayLabel),
    status_note: card.status_note,
  });
  let txt = '';
  let q = 0.0;
  const inW = wlabel ? ` in ${wlabel}` : '';

  if (topic === 'parade' || topic === 'fireworks' || topic === 'show') {
    let items = card.schedule.filter((it) => it.kind === 'Entertainment');
    const re = SHOW_KIND_RE[topic];
    if (re) items = items.filter((it) => re.test(it.name));
    else
      items = items.filter(
        (it) => !Object.values(SHOW_KIND_RE).some((r) => r.test(it.name))
      );
    if (items.length) {
      const last = nights.length ? (nights[nights.length - 1] as string) : null;
      const lines = items
        .slice(0, 3)
        .map((it) =>
          `${it.name}: ${timesText(it.times)} ${patternNote(it, last)}`.trim()
        );
      txt = `At ${head}, ${lines.join('; ')}.`;
      out.schedule = items.slice(0, 3).map((it) => ({
        name: it.name,
        times: it.times,
        nights_posted: it.nights.length,
        nights_same_times: it.nights_with_pattern.length,
        nights: it.nights_with_pattern.map(dayLabel),
      }));
      out.schedule_through = dayLabel(
        card.schedule_nights[card.schedule_nights.length - 1] as string
      );
      q = 1.0;
    } else {
      const listed = (card.offerings[topic] ?? []).map((o) => o.name);
      if (listed.length) {
        out.listed = listed;
        txt = `Disney lists ${listed.slice(0, 3).join(', ')} at ${ev.name} but hasn't posted times for those nights yet.`;
        q = 0.3;
      }
    }
  } else if (topic === 'dates') {
    if (nights.length) {
      const label = wlabel ? `in ${wlabel}` : 'coming up';
      out.night_count = nights.length;
      txt = `${head} has ${nights.length} nights ${label}: ${daysList(nights)}.`;
      if (hours) {
        txt += ` It runs ${hours}`;
        if (card.early_entry_label)
          txt += `, with entry from ${card.early_entry_label}`;
        txt += '.';
      }
      if (sold.length) txt += ` Sold out: ${daysList(sold)}.`;
      q = 1.0;
    } else {
      const upcoming = nightsIn(ev, today, null);
      if (upcoming.length) {
        const ds = upcoming.slice(0, 6);
        out.next_nights = ds.map(dayLabel);
        txt = `No ${ev.name} nights are listed${inW}. The next ones: ${daysList(ds)}.`;
        q = 0.8;
      } else if (card.status_note) {
        txt = `${ev.name}: Disney says "${card.status_note}"`;
        q = 0.8;
      }
    }
  } else if (topic === 'times') {
    if (hours) {
      txt = `${head} runs ${hours}`;
      if (card.early_entry_label)
        txt += `, and party ticket holders can enter from ${card.early_entry_label}`;
      txt += '.';
      q = 1.0;
    }
  } else if (topic === 'price') {
    if (card.on_sale_adult_min !== null) {
      const lo = card.on_sale_adult_min;
      const hi = card.on_sale_adult_max as number;
      const rng = lo === hi ? money(lo) : `${money(lo)} to ${money(hi)}`;
      txt = `Disney's ticket page lists ${rng} (ages 10+, before tax) for the ${ev.name} nights still on sale${inW}.`;
      if (sold.length) txt += ` Sold out: ${daysList(sold)}.`;
      q = 1.0;
    } else if (card.price_min !== null) {
      txt = `Disney lists ${ev.name} tickets at ${money(card.price_min)} to ${money(card.price_max as number)} plus tax, depending on the night.`;
      if (nights.length && sold.length === nights.length)
        txt += ' Every listed night is sold out.';
      q = 0.9;
    }
  } else if (topic === 'rides') {
    let rides = card.schedule
      .filter((it) => it.kind === 'Attraction')
      .map((it) => it.name.replace(/\s+[—–-]\s+New!?$/, ''));
    if (!rides.length) rides = (card.offerings.ride ?? []).map((o) => o.name);
    if (rides.length) {
      out.rides = rides;
      out.ride_count = rides.length;
      txt = `Disney lists ${rides.length} rides open during ${ev.name}, including ${rides.slice(0, 6).join(', ')}.`;
      q = 1.0;
    }
  } else if (topic === 'treats') {
    const treats = card.offerings.treat ?? [];
    if (treats.length) {
      out.treats = treats.map((t) => ({ name: t.name, where: t.location }));
      txt =
        `Disney lists these at ${ev.name}: ` +
        treats
          .slice(0, 5)
          .map((t) => `${t.name}${t.location ? ` at ${t.location}` : ''}`)
          .join('; ') +
        '.';
      q = 1.0;
    }
  }

  if (!txt && !['parade', 'fireworks', 'show'].includes(topic)) {
    // Overview (or a topic with nothing specific captured): what Disney lists.
    const bits: string[] = [];
    if (nights.length) {
      out.night_count = nights.length;
      const more = nights.length > 8 ? '…' : '';
      bits.push(
        `${nights.length} nights ${wlabel ? `in ${wlabel}` : 'coming up'} (${daysList(nights.slice(0, 8))}${more})`
      );
    }
    if (hours) bits.push(hours);
    if (card.price_min !== null)
      bits.push(
        `tickets ${money(card.price_min)} to ${money(card.price_max as number)} plus tax`
      );
    txt = head + (bits.length ? `: ${bits.join(', ')}.` : '.');
    const ent = ['parade', 'fireworks', 'show'].flatMap((k) =>
      (card.offerings[k] ?? []).map((o) => o.name)
    );
    if (ent.length) txt += ` Entertainment: ${ent.slice(0, 4).join(', ')}.`;
    const chars: string[] = [];
    for (const o of card.offerings.character ?? [])
      if (!chars.includes(o.name)) chars.push(o.name);
    if (chars.length)
      txt += ` Characters Disney lists include ${chars.slice(0, 5).join(', ')}.`;
    const rides = card.offerings.ride ?? [];
    if (rides.length) txt += ` ${rides.length} rides are listed as open.`;
    if (sold.length) txt += ` Sold out: ${daysList(sold)}.`;
    if (card.status_note && !nights.length)
      txt += ` Disney: "${card.status_note}"`;
    Object.assign(out, {
      entertainment: ent.slice(0, 4),
      characters: chars.slice(0, 5),
      ride_count: rides.length,
    });
    q = nights.length || ent.length || chars.length ? 1.0 : 0.5;
  }
  out._answer = txt;
  out._quality = txt ? q : 0.0;
  return out;
}

/** A closed attraction named in an answer for a resort where it is closed. */
export function closedNamed(
  common: Common,
  dest: Dest,
  text: string
): string | null {
  if (!common.closed_attractions_destinations.includes(dest)) return null;
  const n = normalize(text);
  return common.closed_attractions.find((c) => hasPhrase(n, c)) ?? null;
}

/**
 * bot_party.facts_party. Silent (quality 0) without parties data for the
 * question, when Disney hasn't posted what was asked, or when the answer
 * would name a closed attraction. Returns null when the bundle has no
 * parties file at all (older bundle): the caller falls back.
 */
export async function partyFacts(
  env: AnswerEnv,
  pq: ParsedQuestion
): Promise<Facts | null> {
  const parties = await partiesFor(env, pq.destination);
  if (!parties) return null;
  const [window, wlabel] = windowOf(pq);
  const today = isoDay(pq.today);
  const out = await partyFactsInner(
    { env, pq, today, window, wlabel },
    parties
  );
  const text: string = out._answer ?? '';
  if (text && out._quality) {
    if (closedNamed(env.common, pq.destination, text)) {
      out._quality = 0.0;
      out._guard_failed = true;
      return out;
    }
    // The bundle is nightly: say when Disney's pages were read.
    const seen = (out._slugs as [Dest, string, PartyEvent][] | undefined)
      ?.map((s) => s[2].seen)
      .filter((x): x is string => !!x)
      .sort();
    const asOf = seen?.length
      ? (seen[seen.length - 1] as string)
      : (parties.captured_at ?? '').slice(0, 10);
    if (asOf) {
      out.as_of = shortIso(asOf);
      out._answer = `${text} From Disney's event pages as of ${out.as_of}.`;
    }
  }
  return out;
}

export function partyText(facts: Facts): string {
  return (facts._answer as string) ?? '';
}

/** bot_party.party_links (only pages the site has). */
export function partyLinks(facts: Facts): Link[] {
  const links: Link[] = [];
  for (const [, , ev] of (facts._slugs as [Dest, string, PartyEvent][]) ?? []) {
    if (ev.url)
      links.push({
        title: `${facts.event ?? 'Party'}: dates, times and characters`,
        url: ev.url,
      });
    if (ev.series_url)
      links.push({ title: 'Ride waits on party nights', url: ev.series_url });
  }
  const seen = new Set<string>();
  const out: Link[] = [];
  for (const l of links) {
    if (!seen.has(l.url)) {
      seen.add(l.url);
      out.push(l);
    }
  }
  return out.slice(0, 3);
}
