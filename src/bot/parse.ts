// Deterministic question parser, ported from the RopeDrop backend's
// bot_parse.py. Turns one question sentence into a ParsedQuestion
// (destination, park, rides, dates, time-of-day window, intent) with enough
// provenance for answer.ts to score confidence in code. No LLM.
//
// Differences from the Python version (see README "Parity"):
//  * all six destinations are answered (Python: WDW + DLR only);
//    international parks use core.intl_ride_aliases and their own park names;
//  * the closed-rides list only applies to WDW/DLR (bundle
//    closed_attractions_destinations), so Tokyo's Splash Mountain resolves;
//  * new intents (crowd patterns, Lightning Lane, menus, ride facts, events,
//    closures) are detected before the original intent patterns.

import { partialRatio, ratio } from './fuzz.js';
import { detectMenu } from './menuItems.js';
import { detectParty, MEET_CUE, partyTopics } from './party.js';
import { hasPhrase, normalize, phraseSpans } from './text.js';
import type { Common, Core, Dest, Ride } from './types.js';
import { DESTS } from './types.js';
import {
  fmtDay,
  hourLabel,
  mkDay,
  MONTH_NAMES,
  monthAbbr,
  weekday,
  WEEKDAY_NAMES,
  ymd,
  type Day,
} from './util.js';

export const MAX_COMPARE_RIDES = 4;

export type Intent =
  | 'current_wait'
  | 'best_time'
  | 'rope_drop'
  | 'compare_rides'
  | 'crowds_on_date'
  | 'park_hours'
  | 'other'
  // new (bundle-backed) intents
  | 'crowd_pattern'
  | 'll_price'
  | 'll_sellout'
  | 'menu_price'
  | 'menu_lookup'
  | 'daw'
  | 'ride_height'
  | 'ride_indoor'
  | 'ride_toddler'
  | 'ride_rain'
  | 'special_events'
  | 'closures'
  // ported from the backend 2026-10-26 (bot_party.py, bot_menu.py)
  | 'party'
  | 'menu';

export type RideMatch = {
  entityId: string;
  name: string;
  slug: string | null;
  parkSlug: string | null;
  score: number; // 0..1
  via: 'alias' | 'fuzzy';
};

export type TimeWindow = {
  start_hour: number;
  end_hour: number;
  label: string;
};

export type ParsedQuestion = {
  normalized: string;
  textLower: string;
  destination: Dest;
  destinationExplicit: boolean;
  supported: boolean;
  parkSlug: string | null;
  parkSource: 'explicit' | 'ride' | 'context' | null;
  ride: RideMatch | null;
  rides: RideMatch[];
  parks: string[];
  rideAliasUnresolved: boolean;
  dates: Day[];
  dateLabel: string | null;
  dateExplicit: boolean;
  /** Asks about a period (season, "which weeks", a month) that no date rule resolved. */
  periodUnresolved?: boolean;
  timeWindow: TimeWindow | null;
  intent: Intent;
  intentKeyword: boolean;
  inherited: string[];
  today: Day;
  /** crowd_pattern sub-kind; ll_* / menu_* detail. */
  sub: string | null;
  /** A child's height in inches, when the question states one. */
  heightIn: number | null;
  /** Match score of a restaurant named by a menu question (set when answering). */
  matchScore: number | null;
  /** Party slug named in the question (bot_parse.detect_party). */
  partySlug: string | null;
  /** Party topics asked about, lead topic first (bot_parse.party_topics). */
  partyTopics: string[];
  /** Food/drink item tokens ("dole", "whip") for the menu intent. */
  menuQuery: string[];
  menuFlavors: boolean;
  menuPrice: boolean;
  /** flavors | where | price | still (question shape). */
  menuKind: string | null;
};

// ---------------------------------------------------------------- destinations / parks

const DLR_ONLY_KEYWORDS = [
  'dca',
  'california adventure',
  'anaheim',
  'disneyland resort',
];

/** Park aliases for the international resorts (the bundle's park_aliases cover WDW/DLR). */
const INTL_PARK_ALIASES: Partial<Record<Dest, Record<string, string>>> = {
  dlp: {
    'disneyland park': 'disneyland_paris',
    'parc disneyland': 'disneyland_paris',
    'walt disney studios': 'walt_disney_studios',
    'walt disney studios park': 'walt_disney_studios',
    wds: 'walt_disney_studios',
    'disney adventure world': 'walt_disney_studios',
  },
  tdr: {
    'tokyo disneyland': 'tokyo_disneyland',
    tdl: 'tokyo_disneyland',
    'tokyo disneysea': 'tokyo_disneysea',
    'tokyo disney sea': 'tokyo_disneysea',
    disneysea: 'tokyo_disneysea',
    'disney sea': 'tokyo_disneysea',
    tds: 'tokyo_disneysea',
  },
  hkdl: {
    'hong kong disneyland': 'hong_kong_disneyland',
    'hk disneyland': 'hong_kong_disneyland',
    'hong kong': 'hong_kong_disneyland',
    hkdl: 'hong_kong_disneyland',
  },
  shdr: {
    'shanghai disneyland': 'shanghai_disneyland',
    'shanghai disney': 'shanghai_disneyland',
    'shanghai disney resort': 'shanghai_disneyland',
    shanghai: 'shanghai_disneyland',
    shdr: 'shanghai_disneyland',
  },
};

export function isUsDest(d: string): boolean {
  return d === 'wdw' || d === 'dlr';
}

function asDest(d: string): Dest {
  return (DESTS as readonly string[]).includes(d) ? (d as Dest) : 'wdw';
}

function intlAliases(common: Common, dest: Dest): Record<string, string> {
  const out: Record<string, string> = { ...(INTL_PARK_ALIASES[dest] ?? {}) };
  const info = common.destinations[dest];
  if (info) {
    for (const p of info.parks) {
      const n = normalize(p.name);
      // "Disneyland Paris" is the resort, not a park, when it has two parks.
      if (info.parks.length > 1 && n === normalize(info.name)) continue;
      out[n] = p.slug;
    }
  }
  return out;
}

export function detectDestination(
  common: Common,
  norm: string
): [Dest, boolean] {
  for (const [dest, kws] of common.destination_keywords) {
    for (const kw of kws) {
      if (hasPhrase(norm, normalize(kw))) return [asDest(dest), true];
    }
  }
  return ['wdw', false];
}

/** Every park named in `norm` (mention order, deduped); only `destination`'s when given. */
export function detectParks(
  common: Common,
  norm: string,
  destination?: Dest
): string[] {
  const out: string[] = [];
  if (destination && !isUsDest(destination)) {
    const table = intlAliases(common, destination);
    for (const [, , alias] of phraseSpans(norm, Object.keys(table))) {
      const slug = table[alias] as string;
      if (!out.includes(slug)) out.push(slug);
    }
    return out;
  }
  for (const [, , alias] of phraseSpans(
    norm,
    Object.keys(common.park_aliases)
  )) {
    const [dest, slug] = common.park_aliases[alias] as [string, string];
    if (destination && dest !== destination) continue;
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

export function parkSlugs(common: Common, dest: Dest): string[] {
  return (common.destinations[dest]?.parks ?? []).map((p) => p.slug);
}

export function parkDisplayName(
  common: Common,
  dest: Dest,
  slug: string
): string {
  const p = common.destinations[dest]?.parks.find((x) => x.slug === slug);
  if (p) return p.name;
  return slug
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Parks a park-level answer covers: every park named when several, else the one park, else all. */
export function targetParks(common: Common, pq: ParsedQuestion): string[] {
  if (pq.parks.length > 1) return [...pq.parks];
  return pq.parkSlug ? [pq.parkSlug] : parkSlugs(common, pq.destination);
}

// ---------------------------------------------------------------- rides

function isClosed(common: Common, dest: Dest, name: string): boolean {
  return (
    common.closed_attractions_destinations.includes(dest) &&
    common.closed_attractions.includes(normalize(name))
  );
}

type Row = { id: string; r: Ride };

function rideRows(common: Common, core: Core): Row[] {
  return Object.entries(core.rides)
    .filter(([, r]) => r.name && !isClosed(common, core.dest, r.name))
    .map(([id, r]) => ({ id, r }));
}

/** bot_parse._resolve_canonical: exact, then shortest prefix, then fuzzy >= threshold. */
function resolveCanonical(
  rows: Row[],
  canonical: string,
  threshold: number
): [Row, number] | null {
  const target = normalize(canonical);
  const exact = rows.filter((x) => x.r.norm === target);
  if (exact.length) return [exact[0] as Row, 1.0];
  const prefix = rows.filter(
    (x) => x.r.norm.startsWith(target) || target.startsWith(`${x.r.norm} `)
  );
  if (prefix.length) {
    const sorted = prefix
      .map((x, i) => ({ x, i }))
      .sort((a, b) => a.x.r.norm.length - b.x.r.norm.length || a.i - b.i);
    return [sorted[0]!.x, 0.97];
  }
  let best: Row | null = null;
  let bestScore = 0;
  for (const x of rows) {
    const s = ratio(target, x.r.norm);
    if (s > bestScore) {
      best = x;
      bestScore = s;
    }
  }
  return best && bestScore >= threshold ? [best, bestScore / 100] : null;
}

function toMatch(x: Row, score: number, via: 'alias' | 'fuzzy'): RideMatch {
  return {
    entityId: x.id,
    name: x.r.name,
    slug: x.r.slug,
    parkSlug: x.r.park,
    score,
    via,
  };
}

export type RideCtx = {
  common: Common;
  core: (d: Dest) => Promise<Core | null>;
};

async function resolveAlias(
  ctx: RideCtx,
  alias: string,
  destination: Dest,
  parkHint: string | null
): Promise<RideMatch | null> {
  const targets = ctx.common.ride_aliases[alias] ?? {};
  const canonical = targets[destination];
  if (!canonical) return null;
  const core = await ctx.core(destination);
  if (!core) return null;
  const rows = rideRows(ctx.common, core);
  const th = ctx.common.fuzzy_threshold;
  let res: [Row, number] | null = null;
  if (parkHint) {
    const parkRows = rows.filter((x) => x.r.park === parkHint);
    res = parkRows.length ? resolveCanonical(parkRows, canonical, th) : null;
  }
  res = res ?? resolveCanonical(rows, canonical, th);
  return res ? toMatch(res[0], res[1], 'alias') : null;
}

async function fuzzyRide(
  ctx: RideCtx,
  norm: string,
  destination: Dest
): Promise<RideMatch[]> {
  const core = await ctx.core(destination);
  if (!core) return [];
  let best: Row | null = null;
  let bestScore = 0;
  let bestLen = 0;
  for (const x of rideRows(ctx.common, core)) {
    for (const v of x.r.variants) {
      const s =
        v.length <= norm.length ? partialRatio(v, norm) : ratio(v, norm);
      if (s > bestScore || (s === bestScore && v.length > bestLen)) {
        best = x;
        bestScore = s;
        bestLen = v.length;
      }
    }
  }
  if (best && bestScore >= ctx.common.fuzzy_threshold) {
    return [toMatch(best, bestScore / 100, 'fuzzy')];
  }
  return [];
}

/**
 * bot_parse.match_rides. Every ride named in `norm`, in mention order.
 * Returns [rides, destinationOverride, aliasUnresolved].
 */
export async function matchRides(
  ctx: RideCtx,
  norm: string,
  destination: Dest,
  destinationExplicit: boolean,
  parkHint: string | null
): Promise<[RideMatch[], Dest | null, boolean]> {
  if (!isUsDest(destination)) {
    // International resorts: their own nicknames once the destination is known.
    const core = await ctx.core(destination);
    if (core) {
      const rides: RideMatch[] = [];
      for (const [, , alias] of phraseSpans(
        norm,
        Object.keys(core.intl_ride_aliases)
      )) {
        const id = core.intl_ride_aliases[alias] as string;
        const r = core.rides[id];
        if (!r || isClosed(ctx.common, destination, r.name)) continue;
        const exact = r.norm === alias || r.variants.includes(alias);
        if (!rides.some((x) => x.entityId === id)) {
          rides.push(toMatch({ id, r }, exact ? 1.0 : 0.97, 'alias'));
        }
      }
      if (rides.length) return [rides, null, false];
    }
    return [await fuzzyRide(ctx, norm, destination), null, false];
  }

  const hits = phraseSpans(norm, Object.keys(ctx.common.ride_aliases)).map(
    (h) => h[2]
  );
  if (hits.length) {
    const first = ctx.common.ride_aliases[hits[0] as string] ?? {};
    let dest: Dest = destination;
    if (!(dest in first)) {
      if (destinationExplicit) dest = destination;
      else if (Object.keys(first).length === 1)
        dest = asDest(Object.keys(first)[0] as string);
      else dest = 'wdw';
    }
    const rides: RideMatch[] = [];
    let unresolved = false;
    for (const alias of hits) {
      if (
        !((ctx.common.ride_aliases[alias] ?? {}) as Record<string, string>)[
          dest
        ]
      ) {
        unresolved = unresolved || alias === hits[0];
        continue;
      }
      const rm = await resolveAlias(ctx, alias, dest, parkHint);
      if (!rm) {
        unresolved = unresolved || alias === hits[0];
        continue;
      }
      if (rides.every((x) => x.entityId !== rm.entityId)) rides.push(rm);
    }
    if (rides.length) return [rides, dest !== destination ? dest : null, false];
    return [[], null, unresolved];
  }
  return [await fuzzyRide(ctx, norm, destination), null, false];
}

// ---------------------------------------------------------------- dates

const WEEKDAYS: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  tues: 1,
  wednesday: 2,
  weds: 2,
  thursday: 3,
  thurs: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function byLenDesc(keys: string[]): string[] {
  return keys
    .map((k, i) => ({ k, i }))
    .sort((a, b) => b.k.length - a.k.length || a.i - b.i)
    .map((x) => x.k);
}

const MNAMES = byLenDesc(Object.keys(MONTHS)).join('|');
const ORD = '(?:st|nd|rd|th)?';
const RANGE_SEP = '\\s*(?:-|\\u2013|\\u2014|to|through|thru|until|til)\\s*';
const MAX_RANGE_DAYS = 14;

function futureDate(
  today: Day,
  month: number,
  day: number,
  year?: number | null
): Day | null {
  if (year) return mkDay(year, month, day);
  const t = ymd(today);
  let d = mkDay(t.y, month, day);
  if (d === null) return null;
  if (d < today) d = mkDay(t.y + 1, month, day);
  return d;
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthWindow(
  textLower: string,
  today: Day
): [Day, Day, string] | null {
  const re = new RegExp(
    `\\b(?:(early|mid|middle of|late|end of|beginning of|start of)[\\s-]+|(?:in|during|for|this|next|of)\\s+)(${MNAMES})\\b(?!\\.?\\s*\\d)`
  );
  const m = re.exec(textLower);
  if (!m) return null;
  const qual = m[1];
  const mon = MONTHS[m[2] as string] as number;
  const t = ymd(today);
  const yr = mon >= t.m ? t.y : t.y + 1;
  const last = lastDay(yr, mon);
  const spans: Record<string, [number, number]> = {
    early: [1, 10],
    'beginning of': [1, 10],
    'start of': [1, 10],
    mid: [11, 20],
    'middle of': [11, 20],
    late: [21, last],
    'end of': [21, last],
  };
  const [lo, hi] = spans[qual ?? ''] ?? [1, last];
  let start = mkDay(yr, mon, lo) as Day;
  const end = mkDay(yr, mon, hi) as Day;
  if (end < today) return null;
  start = Math.max(start, today);
  const label = (qual ? `${qual} ` : '') + MONTH_NAMES[mon - 1];
  return [start, end, label];
}

const PERIOD_WORDS =
  /\b(winter|spring|summer|fall|autumn|season|seasons|weeks|which week|what week|month|months|holidays?|vacation|trip|january|february|april|june|july|august|september|october|november|december)\b/;

// Seasons, as trip planners use them (2026-10-24: "this winter, what weeks are least
// busy?" fell back to today). Winter = Dec 1 - end of Feb, then Mar-May, Jun-Aug, Sep-Nov.
// "this/next <season>" = the one we're in (from today) or else the next one; "next" while
// inside a season = the following year's. Bare "fall" needs a qualifier (it's also a verb);
// "winter/spring/summer break" are holidays (crowd_pattern) and don't match.
const SEASONS: Record<string, [number, number]> = {
  winter: [12, 2],
  spring: [3, 5],
  summer: [6, 8],
  fall: [9, 11],
  autumn: [9, 11],
};

export function seasonWindow(
  textLower: string,
  today: Day
): [Day, Day, string] | null {
  const m =
    /\b(?:(this|next|coming|upcoming|in|during|for|over)\s+(?:the\s+)?)?(winter|spring|summer|fall|autumn)\b(?!\s+(?:break|holidays?|vacation|festival|semester))/.exec(
      textLower
    );
  if (!m) return null;
  const qual = m[1];
  const name = m[2] as string;
  if (name === 'fall' && !qual) return null;
  const [m1, m2] = SEASONS[name] as [number, number];
  const t = ymd(today);
  const inside = m1 <= m2 ? t.m >= m1 && t.m <= m2 : t.m >= m1 || t.m <= m2;
  // Year the season STARTS in: the current one when we're inside it, else the next start.
  let y0 = inside
    ? m1 > m2 && t.m <= m2
      ? t.y - 1
      : t.y
    : t.m < m1
      ? t.y
      : t.y + 1;
  if (inside && qual === 'next') y0 += 1;
  const y1 = m1 <= m2 ? y0 : y0 + 1;
  const start = Math.max(mkDay(y0, m1, 1) as Day, today);
  const end = mkDay(y1, m2, lastDay(y1, m2)) as Day;
  const label =
    `${qual === 'next' ? 'next' : 'this'} ${name} ` +
    `(${MONTH_NAMES[m1 - 1]} ${y0}–${MONTH_NAMES[m2 - 1]} ${y1})`;
  return [start, end, label];
}

function dateListLabel(ds: Day[]): string {
  if (ds.length === 1) return fmtDay(ds[0] as Day);
  const consecutive = ds.every(
    (d, i) => i === 0 || d - (ds[i - 1] as Day) === 1
  );
  if (consecutive && ds.length > 3)
    return `${fmtDay(ds[0] as Day)} to ${fmtDay(ds[ds.length - 1] as Day)}`;
  return ds
    .map((d) => {
      const { m, d: dd } = ymd(d);
      return `${(WEEKDAY_NAMES[weekday(d)] as string).slice(0, 3)} ${monthAbbr(m)} ${dd}`;
    })
    .join(', ');
}

function weekdaysIn(norm: string): [number, boolean, boolean][] {
  const names = byLenDesc(Object.keys(WEEKDAYS));
  const re = new RegExp(`\\b(next )?(${names.join('|')})(s?)\\b`, 'g');
  const out: [number, boolean, boolean][] = [];
  for (const m of norm.matchAll(re)) {
    const wd = WEEKDAYS[m[2] as string] as number;
    if (!out.some((w) => w[0] === wd)) out.push([wd, !!m[1], !!m[3]]);
  }
  return out;
}

export type DateContext = {
  window: [Day, Day] | null;
  month: [number, number] | null;
};

function uniqSorted(ds: Day[]): Day[] {
  return Array.from(new Set(ds)).sort((a, b) => a - b);
}

export function parseDates(
  textLower: string,
  norm: string,
  today: Day,
  ctx?: DateContext | null
): [Day[], string | null, boolean] {
  if (hasPhrase(norm, 'day after tomorrow')) {
    const d = today + 2;
    return [[d], fmtDay(d), true];
  }
  if (
    hasPhrase(norm, 'tomorrow') ||
    hasPhrase(norm, 'tmrw') ||
    hasPhrase(norm, 'tmr')
  ) {
    const d = today + 1;
    return [[d], `tomorrow (${fmtDay(d)})`, true];
  }
  const wdToday = weekday(today);
  if (hasPhrase(norm, 'next week')) {
    const start = today + (7 - wdToday);
    return [Array.from({ length: 7 }, (_, i) => start + i), 'next week', true];
  }
  if (hasPhrase(norm, 'this weekend') || hasPhrase(norm, 'weekend')) {
    const sat = today + ((((5 - wdToday) % 7) + 7) % 7);
    if (wdToday === 6)
      return [[today], `this weekend (${fmtDay(today)})`, true];
    return [[sat, sat + 1], 'this weekend', true];
  }
  if (hasPhrase(norm, 'this week')) {
    const n = 7 - wdToday;
    return [Array.from({ length: n }, (_, i) => today + i), 'this week', true];
  }

  const found: Day[] = [];
  const consumed: [number, number][] = [];
  const free = (a: number, b: number) =>
    !consumed.some(([x, y]) => a < y && x < b);

  const rangeRe = new RegExp(
    `\\b(${MNAMES})\\.?\\s+(\\d{1,2})${ORD}${RANGE_SEP}(?:(${MNAMES})\\.?\\s+)?(\\d{1,2})${ORD}\\b`,
    'g'
  );
  for (const m of textLower.matchAll(rangeRe)) {
    const m1 = MONTHS[m[1] as string] as number;
    const m2 = m[3] ? (MONTHS[m[3]] as number) : m1;
    const start = futureDate(today, m1, Number(m[2]));
    if (start === null) continue;
    const end = mkDay(ymd(start).y + (m2 < m1 ? 1 : 0), m2, Number(m[4]));
    if (end === null) continue;
    if (end - start > 0 && end - start < MAX_RANGE_DAYS) {
      for (let i = 0; i <= end - start; i++) found.push(start + i);
      consumed.push([m.index as number, (m.index as number) + m[0].length]);
    }
  }
  const mdRe = new RegExp(
    `\\b(${MNAMES})\\.?\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?\\b`,
    'g'
  );
  for (const m of textLower.matchAll(mdRe)) {
    const a = m.index as number;
    if (free(a, a + m[0].length)) {
      const d = futureDate(
        today,
        MONTHS[m[1] as string] as number,
        Number(m[2]),
        m[3] ? Number(m[3]) : null
      );
      if (d !== null) {
        found.push(d);
        consumed.push([a, a + m[0].length]);
      }
    }
  }
  const dmRe = new RegExp(
    `\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MNAMES})\\b(?:,?\\s+(\\d{4}))?`,
    'g'
  );
  for (const m of textLower.matchAll(dmRe)) {
    const a = m.index as number;
    if (free(a, a + m[0].length)) {
      const d = futureDate(
        today,
        MONTHS[m[2] as string] as number,
        Number(m[1]),
        m[3] ? Number(m[3]) : null
      );
      if (d !== null) {
        found.push(d);
        consumed.push([a, a + m[0].length]);
      }
    }
  }
  for (const m of textLower.matchAll(
    /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g
  )) {
    let yr: number | null = m[3] ? Number(m[3]) : null;
    if (yr !== null && yr < 100) yr += 2000;
    const d = futureDate(today, Number(m[1]), Number(m[2]), yr);
    if (d !== null) found.push(d);
  }
  if (found.length) {
    const ds = uniqSorted(found);
    return [ds, dateListLabel(ds), true];
  }

  const daysN = Array.from(
    textLower.matchAll(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/g)
  ).map((m) => Number(m[1]));
  if (daysN.length) {
    const out: Day[] = [];
    for (const dn of daysN) {
      if (ctx?.month) {
        const d = mkDay(ctx.month[0], ctx.month[1], dn);
        if (d !== null) out.push(d);
      } else {
        let { y, m: mth } = ymd(today);
        let d: Day | null = null;
        for (let k = 0; k < 3; k++) {
          d = mkDay(y, mth, dn);
          if (d !== null && d >= today) break;
          [y, mth] = mth === 12 ? [y + 1, 1] : [y, mth + 1];
          d = null;
        }
        if (d !== null) out.push(d);
      }
    }
    if (out.length) {
      const ds = uniqSorted(out);
      return [ds, dateListLabel(ds), true];
    }
  }

  const ownWindow =
    monthWindow(textLower, today) ?? seasonWindow(textLower, today);
  const win: [Day, Day] | null = ownWindow
    ? [ownWindow[0], ownWindow[1]]
    : (ctx?.window ?? null);

  const wds = weekdaysIn(norm);
  if (wds.length) {
    let out: Day[] = [];
    if (win) {
      const span: Day[] = [];
      for (let d = win[0]; d <= win[1]; d++) span.push(d);
      let cursor = win[0];
      for (const [wd, , plural] of wds) {
        if (plural) {
          out.push(...span.filter((d) => weekday(d) === wd));
        } else {
          const d =
            span.find((x) => x >= cursor && weekday(x) === wd) ??
            span.find((x) => weekday(x) === wd);
          if (d !== undefined) {
            out.push(d);
            cursor = d;
          }
        }
      }
    }
    if (!out.length) {
      out = wds.map(([wd, nxt]) => {
        let delta = (((wd - wdToday) % 7) + 7) % 7;
        if (nxt && delta === 0) delta = 7;
        return today + delta;
      });
    }
    const ds = uniqSorted(out);
    return [ds, dateListLabel(ds), true];
  }

  if (ownWindow) {
    const [start, end, label] = ownWindow;
    return [
      Array.from({ length: end - start + 1 }, (_, i) => start + i),
      label,
      true,
    ];
  }
  if (
    ['today', 'tonight', 'right now', 'now'].some((w) => hasPhrase(norm, w))
  ) {
    return [[today], 'today', true];
  }
  return [[today], null, false];
}

// ---------------------------------------------------------------- time of day

const TOD_PHRASES: [string, number, number][] = [
  ['early morning', 7, 9],
  ['late morning', 10, 12],
  ['after lunch', 13, 15],
  ['before lunch', 10, 12],
  ['after dinner', 19, 22],
  ['late afternoon', 15, 17],
  ['early afternoon', 12, 14],
  ['late night', 20, 23],
  ['midday', 11, 13],
  ['lunchtime', 11, 13],
  ['lunch', 11, 13],
  ['noon', 12, 12],
  ['morning', 8, 11],
  ['afternoon', 12, 17],
  ['evening', 17, 20],
  ['tonight', 19, 22],
  ['night', 19, 22],
];

export function parseTimeWindow(
  textLower: string,
  norm: string
): TimeWindow | null {
  let m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)/.exec(
    textLower
  );
  if (m) {
    const h = Number(m[1]);
    if (h >= 1 && h <= 12) {
      const pm = (m[3] as string).startsWith('p');
      const h24 = (h % 12) + (pm ? 12 : 0);
      return { start_hour: h24, end_hour: h24, label: hourLabel(h24) };
    }
  }
  m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(textLower);
  if (m) {
    let h = Number(m[1]);
    if (h < 8) h += 12;
    return { start_hour: h, end_hour: h, label: hourLabel(h) };
  }
  m =
    /\b(?:at|around|by)\s+(\d{1,2})\b(?!\s*(?:min|minute|\/|st|nd|rd|th))/.exec(
      textLower
    );
  if (m) {
    const h = Number(m[1]);
    if (h >= 1 && h <= 12) {
      const h24 = h <= 7 ? h + 12 : h;
      return { start_hour: h24, end_hour: h24, label: hourLabel(h24) };
    }
  }
  for (const [phrase, a, b] of TOD_PHRASES) {
    if (hasPhrase(norm, phrase))
      return { start_hour: a, end_hour: b, label: phrase };
  }
  return null;
}

// ---------------------------------------------------------------- intent

const INTENT_PATTERNS: [Intent, RegExp[]][] = [
  [
    'rope_drop',
    [
      /\brope ?drop/,
      /\bat (the )?(park )?open(ing)?\b/,
      /\bfirst thing\b/,
      /\b(ride|do|hit|head to|go to) first\b/,
      /\bfirst (ride|stop|attraction)\b/,
      /\bwhen (the )?park opens\b/,
      /\bright (at|when it) opens?\b/,
    ],
  ],
  [
    'park_hours',
    [
      /\bhours\b/,
      /\bwhat time does\b.*\b(open|close)/,
      /\bwhen does\b.*\b(open|close)/,
      /\b(opening|closing) time\b/,
      /\bopen (until|till|til)\b/,
      /\bclose at\b/,
      /\bearly (entry|park entry)\b/,
      /\bextended evening\b/,
      /\bwhat time .* (opens?|closes?)\b/,
    ],
  ],
  [
    'best_time',
    [
      /\bbest time\b/,
      // 2026-10-26 Reddit: "Is there any good time to ride Tron?" fell through to 'other'.
      /\b(good|better|ideal|right) times? (to|for)\b/,
      /\bwhen('?s| is) (a )?good time\b/,
      /\bwhat time (is best|should)\b/,
      /\bwhen (is the best|should (i|we))\b/,
      /\bshortest (wait|line)/,
      /\blowest wait/,
      /\bquietest time\b/,
      /\bleast busy time\b/,
      /\bwhen to ride\b/,
      /\bbest hour\b/,
      /\bavoid the (line|lines|crowd)/,
      /\bbest day to ride\b/,
      /\bwhen .*\b(wait|line)s? (is|are) (shortest|lowest|short|low)\b/,
    ],
  ],
  [
    'crowds_on_date',
    [
      /\bcrowd/,
      /\bbusy\b/,
      /\bbusiest\b/,
      /\bpacked\b/,
      /\bslow day\b/,
      /\bbest day\b/,
      /\bhow bad\b/,
      /\bleast busy\b/,
      /\bquiet(er|est)? day\b/,
    ],
  ],
  [
    'current_wait',
    [
      /\bwaits?\b/,
      /\bline\b/,
      /\bqueue\b/,
      /\bhow long\b/,
      /\bstandby\b/,
      /\bposted\b/,
    ],
  ],
];

// Opinion / advice / product questions the data can't answer.
const OPINION_PATTERNS = [
  /\bworth\b/,
  /\bvirtual queue\b/,
  /\bboarding group/,
  /\blightning lane\b/,
  /\bll\b/,
  /\bmulti ?pass\b/,
  /\bsingle ?pass\b/,
  /\bgenie\b/,
  /\bpremier pass\b/,
  /\bshould (i|we) (buy|get|skip|bother|pay|splurge)\b/,
  /\brecommend/,
  /\bscary\b/,
  /\bintense\b/,
  /\bmotion sick/,
  /\bheight (requirement|limit|restriction)/,
  /\bhow tall\b/, // 2026-10-24 mined-question test: "Is it crazy to say they should refurbish Space
  // Mountain?" got a closure-status reply.
  /\bshould (they|disney|it) (be )?\w+/,
  /\bis it (crazy|just me|weird|bad|wrong)\b/,
  /\bam i (crazy|wrong|the only one)\b/,
  /\bdo (you|yall|you guys|people) think\b/,
  /\bthoughts on\b/,
  /\bunpopular opinion\b/,
];

/** Opinion wording that also silences the new data intents. */
const HARD_OPINION = [
  /\bworth\b/,
  /\bvirtual queue\b/,
  /\bboarding group/,
  /\bshould (i|we) (buy|get|skip|bother|pay|splurge)\b/,
  /\brecommend/,
  /\bscary\b/,
  /\bintense\b/,
  /\bmotion sick/,
  /\b(better|best) (restaurant|place to eat|hotel|resort)\b/, // 2026-10-24 mined-question test: "Is it crazy to say they should refurbish Space
  // Mountain?" got a closure-status reply.
  /\bshould (they|disney|it) (be )?\w+/,
  /\bis it (crazy|just me|weird|bad|wrong)\b/,
  /\bam i (crazy|wrong|the only one)\b/,
  /\bdo (you|yall|you guys|people) think\b/,
  /\bthoughts on\b/,
  /\bunpopular opinion\b/,
];

export function isOpinion(norm: string): boolean {
  return OPINION_PATTERNS.some((p) => p.test(norm));
}

export function detectIntent(norm: string): Intent | null {
  if (isOpinion(norm)) return null;
  for (const [intent, pats] of INTENT_PATTERNS) {
    if (pats.some((p) => p.test(norm))) return intent;
  }
  return null;
}

const COMPARE_CUES =
  /\b(first|before|order|then|vs|versus|which one|rope ?drop|at (the )?open(ing)?|or)\b/;
const ORDER_CUES =
  /\b(first|before|order|then|which one|rope ?drop|at (the )?open(ing)?)\b/;
const CARRY_CUES = new RegExp(
  '\\b(is|does|would|will) (that|this)\\b|\\b(that|this|the|our|my) (order|plan|lineup|sequence)\\b' +
    '|\\bgood order\\b|\\bright order\\b|\\bin that order\\b|\\bmake sense\\b' +
    '|\\bwhich (one|of those|of these|of them)\\b|\\b(those|these|them)\\b'
);
const TYPICAL_WORDS =
  /\b(usually|typically|normally|generally|on average|average|typical)\b/;

// ---------------------------------------------------------------- new intents

const LL_WORDS =
  /\b(lightning lanes?|ll|llmp|llsp|multi ?pass|single ?pass|premier pass|individual lightning lane|ill|genie)\b/;
const PRICE_WORDS =
  /\b(how much|price|prices|priced|pricing|cost|costs|costing)\b/;
const SELLOUT_WORDS = /\b(sell|sells|selling|sold) out\b|\bsellouts?\b/;
const SELLOUT_LL_WORDS =
  /\b(run|runs|running) out\b|\bgone by\b|\bstill available\b/;
const RAIN_WORDS =
  /\b(rain|rains|raining|rainy|thunderstorms?|storms?|lightning(?! (lanes?|mcqueen)\b))\b/;
const HEIGHT_WORDS =
  /\bheight (requirements?|limits?|restrictions?|minimum|min)\b|\bminimum height\b|\bheight\b.*\b(ride|rides|kid|kids|child|son|daughter)\b|\bhow tall\b.*\b(to ride|be|need|needs|must|kid|kids|child|son|daughter)\b|\btall enough\b/;
const TODDLER_WORDS =
  /\b(toddlers?|babies|baby|infants?|preschoolers?|little ones|no height (requirement|requirements|limit|minimum|restriction))\b|\b[1-4] ?(year|yr) olds?\b/;
const INDOOR_WORDS =
  /\b(indoors?|inside rides?|air conditioned|air conditioning|ac rides?|out of the heat|escape the heat)\b/;
const CLOSURE_WORDS =
  /\brefurb\w*|\bclosed\b|\bclosures?\b|\bdown for\b|\bunder construction\b|\bnot operating\b/;
const EVENT_WORDS = new RegExp(
  '\\b(special|ticketed|hard ticket|after hours|seasonal) events?\\b|\\b(any|what|which) (special )?events?\\b' +
    '|\\bevents? (on|at|this|next|tonight|today|tomorrow|during)\\b' +
    '|\\b(halloween|christmas|holiday|not so scary|very merry|boo bash|oogie boogie|villains|pride|after hours|ticketed|hard ticket) ' +
    '(party|parties|nite|nites|night|nights|bash|event|events)\\b' +
    '|\\bmnsshp\\b|\\bmvmcp\\b|\\bjollywood\\b|\\bparty (dates|nights?|days?)\\b|\\bfestival\\b'
);
const CROWD_WORDS = /\bcrowd|\bbusy\b|\bbusier\b|\bbusiest\b|\bpacked\b/;
const DAW_WORDS =
  /\bdrinking around the world\b|\bdaw\b|\bdrink(ing)? around (the )?world\b/;
const MENU_WORDS =
  /\bmenus?\b|\bwhat (do|does) (they|it) (serve|have)\b|\bwhat can (i|we) (eat|get|order)\b|\bserve[sd]? for (breakfast|lunch|dinner|brunch)\b/;
const NOT_FOOD_PRICE =
  /\bhow much (time|longer|wait|of a wait|earlier|later|before|after)\b/;
const WEEKPART =
  /\bweekends?\b.*\bweekdays?\b|\bweekdays?\b.*\bweekends?\b|\bweekends? (busier|more crowded|worse|quieter|better|less busy)\b|\b(busier|more crowded|worse|quieter|better|less busy) (on|during) (the )?weekends?\b|\bsaturday or sunday\b|\bsunday or saturday\b/;
const QUIET_DOW =
  /\b(day|days) of the week\b|\bwhich (week)?day is (usually|typically|generally|normally)\b|\b(quietest|least busy|least crowded|best|busiest) weekday\b/;
const HOLIDAY_WORDS =
  /\bholidays?\b|\bgolden week\b|\b(chinese|lunar) new year\b|\bspring festival\b|\bspring break\b|\bsummer (break|holidays?|vacation)\b|\bwinter break\b|\bthanksgiving\b|\bchristmas\b|\bnew years?\b|\bmid autumn\b|\bnational day\b|\beaster\b|\bqingming\b|\bdragon boat\b|\bmay day\b|\blabou?r day\b|\bschool (holidays?|breaks?|vacations?)\b|\bhalf term\b|\bobon\b|\bsilver week\b/;

/** Child height in inches ("40 inches", "40-inch", 40", "102 cm", "3'4""). */
export function childHeight(textLower: string): number | null {
  let m =
    /\b(\d{2,3}(?:\.\d)?)\s*-?\s*(?:inches\b|inch\b|in\.?(?=\s*(?:$|[,.;:!?)]|tall\b|kid|child|son\b|daughter|boy|girl|toddler|and\b|or\b))|["\u201d\u2033])/.exec(
      textLower
    );
  if (m) {
    const v = Number(m[1]);
    return v >= 20 && v <= 80 ? v : null;
  }
  m = /\b(\d{2,3})\s*cm\b/.exec(textLower);
  if (m) {
    const v = Number(m[1]) / 2.54;
    return v >= 20 && v <= 80 ? Math.round(v * 10) / 10 : null;
  }
  m = /\b([3-5])\s*(?:'|ft\b|feet\b|foot\b)\s*(\d{1,2})?/.exec(textLower);
  if (m && /\b(tall|height|kid|child|son|daughter)\b/.test(textLower)) {
    return Number(m[1]) * 12 + Number(m[2] ?? 0);
  }
  return null;
}

function detectExtra(
  norm: string,
  textLower: string,
  heightIn: number | null,
  dateExplicit: boolean
): [Intent, string | null] | null {
  if (HARD_OPINION.some((p) => p.test(norm))) return null;
  if (DAW_WORDS.test(norm)) return ['daw', null];
  const ll = LL_WORDS.test(norm);
  if (SELLOUT_WORDS.test(norm) || (ll && SELLOUT_LL_WORDS.test(norm)))
    return ['ll_sellout', null];
  if (ll && PRICE_WORDS.test(norm)) return ['ll_price', null];
  if (ll) return null; // other Lightning Lane questions stay opinion/silent
  if (RAIN_WORDS.test(norm)) return ['ride_rain', null];
  if (HEIGHT_WORDS.test(norm) || heightIn !== null)
    return ['ride_height', null];
  if (TODDLER_WORDS.test(norm)) return ['ride_toddler', null];
  if (INDOOR_WORDS.test(norm)) return ['ride_indoor', null];
  if (
    CLOSURE_WORDS.test(norm) &&
    !/\bwhat time\b|\bwhen does\b|\bclosing time\b/.test(norm)
  ) {
    return ['closures', null];
  }
  if (MENU_WORDS.test(norm)) return ['menu_lookup', null];
  if (
    PRICE_WORDS.test(norm) &&
    !NOT_FOOD_PRICE.test(norm) &&
    !/\btickets?\b|\bpark pass\b|\bhotels?\b|\bresorts? room\b|\bparking\b|\bpark hopper\b|\bannual pass/.test(
      norm
    )
  ) {
    return ['menu_price', null];
  }
  if (/\$\s?\d/.test(textLower) && /\bmenu|\bfood|\bsnack|\bdrink/.test(norm))
    return ['menu_price', null];
  if (EVENT_WORDS.test(norm) && !CROWD_WORDS.test(norm))
    return ['special_events', null];
  if (WEEKPART.test(norm)) return ['crowd_pattern', 'weekpart'];
  if (
    HOLIDAY_WORDS.test(norm) &&
    (CROWD_WORDS.test(norm) || /\bhow (bad|crazy)\b|\bwait/.test(norm))
  ) {
    return ['crowd_pattern', 'holiday'];
  }
  if (QUIET_DOW.test(norm) && (!dateExplicit || /\bof the week\b/.test(norm))) {
    return ['crowd_pattern', 'dow'];
  }
  return null;
}

// ---------------------------------------------------------------- context

export type PostContext = {
  destination: Dest | null;
  parks: string[];
  dates: Day[];
  dateLabel: string | null;
  dateExplicit: boolean;
  dateCtx: DateContext | null;
  /** A child's height stated anywhere in the post ("My son is 47 inches."). */
  heightIn: number | null;
};

export function buildContext(
  common: Common,
  text: string,
  today: Day
): PostContext {
  const norm = normalize(text);
  const tl = (text ?? '').toLowerCase().replace(/’/g, "'");
  const ctx: PostContext = {
    destination: null,
    parks: [],
    dates: [],
    dateLabel: null,
    dateExplicit: false,
    dateCtx: null,
    heightIn: childHeight(tl),
  };
  const dests: Dest[] = [];
  for (const [dest, kws] of common.destination_keywords) {
    const d = asDest(dest);
    if (kws.some((k) => hasPhrase(norm, normalize(k))) && !dests.includes(d))
      dests.push(d);
  }
  for (const [, , alias] of phraseSpans(
    norm,
    Object.keys(common.park_aliases)
  )) {
    const d = asDest((common.park_aliases[alias] as [string, string])[0]);
    if (!dests.includes(d)) dests.push(d);
  }
  // "Disneyland Paris" / "Tokyo Disneyland" also hit the "disneyland" DLR
  // keyword: drop DLR then, unless a DLR-only name is there too.
  if (
    dests.includes('dlr') &&
    dests.some((d) => !isUsDest(d)) &&
    !DLR_ONLY_KEYWORDS.some((k) => hasPhrase(norm, k))
  ) {
    dests.splice(dests.indexOf('dlr'), 1);
  }
  if (dests.length === 1) ctx.destination = dests[0] as Dest;
  if (ctx.destination) ctx.parks = detectParks(common, norm, ctx.destination);
  [ctx.dates, ctx.dateLabel, ctx.dateExplicit] = parseDates(tl, norm, today);
  const win = monthWindow(tl, today);
  const dc: DateContext = { window: null, month: null };
  if (win) {
    dc.window = [win[0], win[1]];
    const w = ymd(win[0]);
    dc.month = [w.y, w.m];
  } else if (
    ctx.dateExplicit &&
    ctx.dateLabel !== 'today' &&
    ctx.dates.length
  ) {
    if (ctx.dates.length > 1)
      dc.window = [ctx.dates[0] as Day, ctx.dates[ctx.dates.length - 1] as Day];
    const f = ymd(ctx.dates[0] as Day);
    dc.month = [f.y, f.m];
  }
  ctx.dateCtx = dc;
  return ctx;
}

// ---------------------------------------------------------------- entry point

export type ParseEnv = RideCtx & {
  /** Park-local "today" for a destination (tests pass a fixed day). */
  today: (dest: Dest) => Day;
  /** Does any WDW/DLR menu row name these item tokens (in order)? */
  menuNameExists?: (tokens: string[]) => Promise<boolean>;
};

export async function parseQuestion(
  env: ParseEnv,
  question: string,
  context?: PostContext | null,
  prevSentences?: string[] | null
): Promise<ParsedQuestion> {
  const common = env.common;
  const textLower = (question ?? '').toLowerCase().replace(/’/g, "'");
  const norm = normalize(question);
  let [dest, explicit] = detectDestination(common, norm);
  const inherited: string[] = [];
  if (!explicit && context?.destination) {
    [dest, explicit] = [context.destination, true];
    inherited.push('destination');
  }
  const pq: ParsedQuestion = {
    normalized: norm,
    textLower,
    destination: dest,
    destinationExplicit: explicit,
    supported: true,
    parkSlug: null,
    parkSource: null,
    ride: null,
    rides: [],
    parks: [],
    rideAliasUnresolved: false,
    dates: [],
    dateLabel: null,
    dateExplicit: false,
    timeWindow: null,
    intent: 'other',
    intentKeyword: false,
    inherited,
    today: 0,
    sub: null,
    heightIn: null,
    matchScore: null,
    partySlug: null,
    partyTopics: [],
    menuQuery: [],
    menuFlavors: false,
    menuPrice: false,
    menuKind: null,
  };

  let parks = detectParks(common, norm, pq.destination);
  if (!parks.length && !explicit) {
    // A DLR park alias ("DCA") without any destination keyword.
    const anyp = detectParks(common, norm);
    if (anyp.length) {
      const hit = Object.values(common.park_aliases).find(
        (v) => v[1] === anyp[0]
      );
      const d2 = asDest(hit ? hit[0] : 'wdw');
      pq.destination = d2;
      pq.destinationExplicit = true;
      parks = detectParks(common, norm, d2);
    }
  }
  if (parks.length) {
    pq.parkSlug = parks[0] as string;
    pq.parkSource = 'explicit';
  }
  const allParks = parkSlugs(common, pq.destination);
  const ctxParks = (context?.parks ?? []).filter((p) => allParks.includes(p));
  const parkHint =
    pq.parkSlug ?? (ctxParks.length === 1 ? (ctxParks[0] as string) : null);

  const matched = await matchRides(
    env,
    norm,
    pq.destination,
    pq.destinationExplicit,
    parkHint
  );
  let rides = matched[0];
  const [, destOverride, unresolved] = matched;
  let carriedText = '';
  if (prevSentences?.length && CARRY_CUES.test(norm)) {
    let prev: RideMatch[] = [];
    for (const sent of prevSentences.slice(0, 4)) {
      const [got] = await matchRides(
        env,
        normalize(sent),
        destOverride ?? pq.destination,
        true,
        parkHint
      );
      if (!got.length) break;
      prev = [
        ...got,
        ...prev.filter((r) => got.every((g) => g.entityId !== r.entityId)),
      ];
      carriedText = `${normalize(sent)} ${carriedText}`;
    }
    if (prev.length) {
      const merged = [...prev];
      for (const r of rides) {
        if (merged.every((x) => x.entityId !== r.entityId)) merged.push(r);
      }
      if (merged.length > rides.length) inherited.push('rides');
      rides = merged;
    }
  }
  pq.rideAliasUnresolved = unresolved && !rides.length;
  if (rides.length) {
    if (destOverride) pq.destination = destOverride;
    pq.rides = rides;
    pq.ride = rides[0] as RideMatch;
    if (pq.ride.parkSlug && pq.ride.parkSlug !== pq.parkSlug) {
      pq.parkSlug = pq.ride.parkSlug;
      pq.parkSource = 'ride';
    }
  }
  if (parks.length) {
    pq.parks = !rides.length
      ? parks
      : [pq.parkSlug as string, ...parks.filter((p) => p !== pq.parkSlug)];
  } else if (rides.length) {
    pq.parks = pq.parkSlug ? [pq.parkSlug] : [];
  } else if (ctxParks.length) {
    pq.parks = ctxParks;
    if (ctxParks.length === 1) {
      pq.parkSlug = ctxParks[0] as string;
      pq.parkSource = 'context';
    }
    inherited.push('parks');
  }

  const today = env.today(pq.destination);
  pq.today = today;
  [pq.dates, pq.dateLabel, pq.dateExplicit] = parseDates(
    textLower,
    norm,
    today,
    context?.dateCtx ?? null
  );
  if (
    !pq.dateExplicit &&
    context &&
    context.dateExplicit &&
    context.dateLabel !== 'today' &&
    context.dates.length
  ) {
    pq.dates = [...context.dates];
    pq.dateLabel = context.dateLabel;
    pq.dateExplicit = true;
    inherited.push('dates');
  }
  pq.timeWindow = parseTimeWindow(textLower, norm);
  pq.heightIn = childHeight(textLower);

  // Ticketed parties / After Hours (bot_parse, 2026-10-26): a named party, or a
  // meet-a-character question (answered only for characters Disney lists at a
  // party; party.ts). Facts only, so this also takes "is X worth it?".
  const party = detectParty(
    norm,
    pq.destinationExplicit ? pq.destination : null,
    pq.parkSlug
  );
  if (party || (MEET_CUE.test(norm) && !pq.rides.length)) {
    if (party) {
      if (!pq.destinationExplicit || party[0] === pq.destination) {
        if (party[0] !== pq.destination) {
          pq.destination = party[0];
          pq.today = env.today(party[0]);
        }
        pq.destinationExplicit = true;
      }
      pq.partySlug = party[1];
    }
    pq.partyTopics = partyTopics(norm);
    pq.intent = 'party';
    pq.intentKeyword = true;
    return pq;
  }

  // Food / drink items (bot_parse.detect_menu, 2026-10-26): "what flavors of
  // Dole Whip", "where can I get a churro", "is the Mickey pretzel still at MK",
  // "how much is a churro". Never for ride, opinion, Lightning Lane or Drinking
  // Around the World questions; a phrase that isn't a clear food word must
  // match a menu item name. Answered by menuItems.ts (WDW/DLR); other resorts
  // and restaurant-named price questions fall back to menu_price there.
  if (
    !pq.rides.length &&
    !isOpinion(norm) &&
    !DAW_WORDS.test(norm) &&
    !LL_WORDS.test(norm)
  ) {
    const menu = detectMenu(norm, common.park_aliases);
    if (
      menu &&
      (menu.strong || (await env.menuNameExists?.(menu.tokens)) === true)
    ) {
      pq.menuQuery = menu.tokens;
      pq.menuFlavors = menu.flavors;
      pq.menuPrice = menu.price;
      pq.menuKind = menu.kind;
      pq.intent = 'menu';
      pq.intentKeyword = true;
      return pq;
    }
  }

  const extra = detectExtra(norm, textLower, pq.heightIn, pq.dateExplicit);
  if (
    extra?.[0] === 'ride_height' &&
    pq.heightIn === null &&
    context?.heightIn
  ) {
    pq.heightIn = context.heightIn;
    inherited.push('height');
  }
  if (extra) {
    pq.intent = extra[0];
    pq.sub = extra[1];
    pq.intentKeyword = true;
    return pq;
  }

  const opinion = isOpinion(norm);
  const detected = detectIntent(norm);
  pq.intentKeyword = detected !== null;
  let intent: Intent = detected ?? 'other';
  if (
    pq.rides.length >= 2 &&
    !opinion &&
    (COMPARE_CUES.test(norm) ||
      (inherited.includes('rides') && ORDER_CUES.test(carriedText))) &&
    (!pq.timeWindow || ORDER_CUES.test(norm)) &&
    intent !== 'park_hours'
  ) {
    pq.intent = 'compare_rides';
    pq.intentKeyword = true;
    return pq;
  }
  const isToday = pq.dates.length === 1 && pq.dates[0] === today;
  const nowWords = ['now', 'right now', 'currently', 'at the moment'].some(
    (w) => hasPhrase(norm, w)
  );
  if (intent === 'crowds_on_date' && pq.ride) {
    intent =
      nowWords || (isToday && !pq.timeWindow && !pq.dateExplicit)
        ? 'current_wait'
        : 'best_time';
  }
  if (
    intent === 'current_wait' &&
    !nowWords &&
    (pq.timeWindow || !isToday || TYPICAL_WORDS.test(norm))
  ) {
    intent = 'best_time';
  }
  if (
    intent === 'crowds_on_date' &&
    !pq.dateExplicit &&
    /\b(best|least busy|quiet(er|est)?) day\b/.test(norm)
  ) {
    pq.dates = Array.from({ length: 7 }, (_, i) => today + i);
    pq.dateLabel = 'the next 7 days';
  }
  // 2026-10-24: "this winter, what weeks are least busy?" parsed no date, fell back to
  // today and nearly posted today's crowd levels. A period nobody resolved is not today.
  if (
    (intent === 'crowds_on_date' || intent === 'park_hours') &&
    !pq.dateExplicit &&
    PERIOD_WORDS.test(norm)
  ) {
    pq.periodUnresolved = true;
  }
  pq.intent = intent;
  return pq;
}

// ---------------------------------------------------------------- post splitting

const MENTION_RE =
  /(?<![\w/])\/?u\/(?:ropedrop[-_]?bot|ropedrop[-_]?planner[-_]?bot)\b[,:]?/gi;
const EMOJI =
  '\\u{1F300}-\\u{1FAFF}\\u2600-\\u27BF\\u2B50\\u2B06\\u2194-\\u21AA';
const ABBREV = new Set(
  (
    'jan feb mar apr jun jul aug sep sept oct nov dec st mt ft mr mrs ms dr jr sr vs approx ' +
    'etc eg ie e.g i.e a.m p.m am pm no min mins hr hrs est pst ave rd blvd'
  ).split(' ')
);
const BULLET_RE = /^(?:[-*•+>]|\d{1,2}[.)])\s+/;
const FILLER_RE = new RegExp(
  '^(?:(?:so|also|and|but|ok|okay|oh|plus|edit|update|question|q|quick question|hey|hi|hello|' +
    'pls|please|lastly|finally|second|secondly|third|one more thing|last thing|anyway|btw)\\b[\\s,:!.\\-]*)+'
);
const WH_START =
  /^(how|what|whats|when|whens|where|which|who|whos|why|any ?one|any ?body)\b/;
const AUX_START =
  /^(is|are|was|were|should|shall|can|could|would|will|does|do|did|has|have|am|any)\b/;
const MID_Q = new RegExp(
  '\\bany (tips|advice|suggestions|recommendations|thoughts|ideas)\\b' +
    '|\\b(does|do|did) any ?(one|body) (know|have|remember)\\b' +
    '|\\bwondering (if|whether|what|when|how|which)\\b|\\blooking for (advice|tips|recommendations)\\b' +
    '|\\bhelp me (decide|figure|choose|plan)\\b|\\bplease advise\\b'
);
const NOT_FRAGMENT = new RegExp(
  '^(psa|trip report|tr|update|edit|rant|photo|pic|pics|throwback|reminder)\\b' +
    '|\\b(was|were|had|got|went|did|just|finally|loved|love|amazing|awesome)\\b'
);

/** Remove u/ropedropplannerbot (and the old u/ropedrop-bot) mentions. */
export function stripMentions(text: string): string {
  return (text ?? '').replace(MENTION_RE, ' ').trim();
}

function isUpper(c: string): boolean {
  return c !== c.toLowerCase() && c === c.toUpperCase();
}

function splitLine(line: string): string[] {
  const chunks = line.split(new RegExp(`(?<=[${EMOJI}])\\s+(?=[A-Z])`, 'u'));
  const out: string[] = [];
  for (const chunk of chunks) {
    let start = 0;
    const re = /([.!?]+|…)(["'”’)\]]*)(\s+|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk)) !== null) {
      const end = m.index + m[0].length;
      const rest = chunk.slice(end);
      if (!rest) break;
      const punct = m[1] as string;
      if (!punct.includes('?') && !punct.includes('!')) {
        if (punct === '.' || punct === '…' || /^\.+$/.test(punct)) {
          const prev = /([A-Za-z.]+)$/.exec(chunk.slice(start, m.index));
          const pw = prev
            ? (prev[1] as string).toLowerCase().replace(/^\.+|\.+$/g, '')
            : '';
          if (punct === '.' && (ABBREV.has(pw) || pw.length === 1)) continue;
          const c0 = rest[0] as string;
          if (!(isUpper(c0) || '"\'“(['.includes(c0))) continue;
        }
      }
      out.push(
        chunk
          .slice(
            start,
            m.index + (m[1] as string).length + (m[2] as string).length
          )
          .trim()
      );
      start = end;
    }
    const tail = chunk.slice(start).trim();
    if (tail) out.push(tail);
  }
  return out.filter((s) => /[A-Za-z0-9]/.test(s));
}

export function splitSentences(text: string): string[] {
  const blocks: (string | null)[] = [];
  const endRe = new RegExp(`[.!?:\\u2026${EMOJI}]\\s*$`, 'u');
  for (const raw of (text ?? '').replace(/\r/g, '').split('\n')) {
    let line = raw.trim();
    if (!line) {
      blocks.push(null);
      continue;
    }
    const bullet = BULLET_RE.test(line);
    line = line.replace(BULLET_RE, '').trim();
    if (!line) continue;
    const prev = blocks.length ? blocks[blocks.length - 1] : null;
    const first = line.slice(0, 1);
    if (
      prev !== null &&
      prev !== undefined &&
      !bullet &&
      first !== first.toUpperCase() &&
      first === first.toLowerCase() &&
      !endRe.test(prev)
    ) {
      blocks[blocks.length - 1] = `${prev} ${line}`;
    } else {
      blocks.push(line);
    }
  }
  const out: string[] = [];
  for (const b of blocks) if (b) out.push(...splitLine(b));
  return out;
}

function questionCore(sentence: string): string {
  return sentence
    .trim()
    .replace(new RegExp(`[\\s${EMOJI}"'\\u201d\\u2019)\\]]+$`, 'u'), '');
}

export function isQuestionSentence(sentence: string): boolean {
  const core = questionCore(sentence);
  if (!core) return false;
  let low = core.toLowerCase().replace(/’/g, "'").replace(/'/g, '');
  low = low.replace(FILLER_RE, '').trim();
  if (
    /^(what an?|who knew|who would have|how (lucky|amazing|awesome|cool|great|fun|crazy|nice))\b/.test(
      low
    )
  ) {
    return false;
  }
  if (core.endsWith('?')) return true;
  if (core.endsWith('!')) return false;
  if (WH_START.test(low)) return true;
  if (AUX_START.test(low) && !core.endsWith('.')) return true;
  return MID_Q.test(low);
}

export function isQueryFragment(
  sentences: string[],
  extraIntent: (s: string) => boolean
): boolean {
  if (sentences.length !== 1) return false;
  const s = (sentences[0] as string).trim();
  if (/[.!]\s*$/.test(s) || s.split(/\s+/).length > 14) return false;
  const low = s.toLowerCase().replace(/’/g, "'").replace(/'/g, '');
  if (NOT_FRAGMENT.test(low)) return false;
  return detectIntent(normalize(s)) !== null || extraIntent(s);
}

/** A search-style fragment ("dole whip price") naming one of the new intents. */
export function fragmentHasExtraIntent(s: string): boolean {
  const tl = s.toLowerCase();
  return detectExtra(normalize(s), tl, childHeight(tl), false) !== null;
}

export function questionSentences(text: string): [string[], number[]] {
  const sents = splitSentences(stripMentions(text));
  let idx = sents
    .map((s, i) => (isQuestionSentence(s) ? i : -1))
    .filter((i) => i >= 0);
  if (!idx.length && isQueryFragment(sents, fragmentHasExtraIntent)) idx = [0];
  return [sents, idx];
}
