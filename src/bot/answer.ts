/* eslint-disable @typescript-eslint/no-explicit-any */
// Answer pipeline, ported from the RopeDrop backend's bot_answer.py:
//
//   question --parse (parse.ts)--> ParsedQuestion
//            --retrieve--> facts (read from the precomputed bundle only)
//            --compose--> deterministic template answer (no LLM)
//            --score--> confidence, computed in code, plus a number guard
//                       that caps confidence when the answer has a number
//                       the facts don't back.
//
// Facts are plain objects shaped like the Python dicts (keys starting with
// "_" are internal) so templates, links, the number guard and confidence
// match the Python version line for line. Documented differences:
//  * A. best/worst hours ignore hours with < 10% of the ride's busiest hour's
//       samples (after-close stragglers) — this is what kept time-of-day
//       answers ("Flight of Passage wait in the afternoon") at 0.66;
//  * B. "which ride first" uses the opening-rush 15-minute profile;
//  * no live waits in the bundle: current-wait answers fall back to the
//    historical typical wait (quality 0.5, i.e. silent at 0.7), exactly
//    what the Python code does when its live cache is stale.
// Post text is never logged or sent anywhere.

import {
  EXTRA_INTENTS,
  EXTRA_LABELS,
  extraFacts,
  extraLinks,
  extraParseScore,
  extraTemplate,
} from './extra.js';
import {
  buildContext,
  MAX_COMPARE_RIDES,
  parkDisplayName,
  parkSlugs,
  parseQuestion,
  questionSentences,
  stripMentions,
  targetParks,
  type Intent,
  type ParsedQuestion,
  type ParseEnv,
  type RideMatch,
} from './parse.js';
import type { BundleSource, Common, Core, Dest, Hours, Ride } from './types.js';
import { localParts, localToday } from './tz.js';
import {
  cpSlice,
  fmtDay,
  hourLabel,
  isoDay,
  pyRound,
  pyRoundInt,
  shortIso,
  weekday,
  WEEKDAY_NAMES,
  wordCount,
  type Day,
} from './util.js';

export const SITE = 'https://ropedropplanner.com';
export const GUARD_CONFIDENCE_CAP = 0.45;
export const DEFAULT_BOT_THRESHOLD = 0.7;
const HOUR_MIN = 8;
const HOUR_MAX = 21;
const MIN_HOUR_SAMPLES = 3;
/** Fix A: hours with fewer samples than this share of the busiest hour are ignored. */
export const SPARSE_HOUR_FRACTION = 0.1;
/** Fix B: opening-rush cells (15-min buckets aligned to the official open). */
export const RUSH_OPEN_CELL = 4;
export const RUSH_LATER_CELL = 12;
export const RUSH_WINDOW_DAYS = 60;

export type Link = { title: string; url: string };
export type Facts = { [k: string]: any };

export type AnswerEnv = {
  src: BundleSource;
  common: Common;
  now: Date;
  /** Fixed "today" for every destination (tests / parity); default = park-local today. */
  today?: Day;
  threshold?: number;
};

export type Part = {
  answer: string;
  confidence: number;
  intent: Intent;
  links: Link[];
  label: string;
  pq: ParsedQuestion;
  guardViolations: number;
};

export type PostResult = {
  answer: string;
  confidence: number;
  links: Link[];
  intent: string;
  parts: Part[];
  nQuestions: number;
};

// ---------------------------------------------------------------- helpers

export function crowdLabel(level: number): string {
  return level <= 3 ? 'Low' : level >= 7 ? 'High' : 'Moderate';
}

export function sampleQuality(n: number | null | undefined): number {
  const x = n ?? 0;
  if (x >= 200) return 1.0;
  if (x >= 50) return 0.85;
  if (x >= 10) return 0.6;
  if (x > 0) return 0.3;
  return 0.0;
}

type Hourly = Map<number, [number, number]>;

export function hasWaitData(r: Ride | undefined | null): boolean {
  return !!r?.waits?.hour?.some((c) => c);
}

/** bot_answer.ride_hourly: (data, basis) — the weekday row when asked, else all days. */
export function rideHourly(
  r: Ride | undefined | null,
  dow: number | null
): [Hourly, 'dow_hour' | 'hour'] {
  const w = r?.waits;
  if (dow !== null && w?.dow_hour) {
    const row = w.dow_hour[dow] ?? [];
    const m: Hourly = new Map();
    row.forEach((c, h) => {
      if (c) m.set(h, [pyRoundInt(c[0]), Math.trunc(c[1])]);
    });
    if (m.size) return [m, 'dow_hour'];
  }
  const m: Hourly = new Map();
  (w?.hour ?? []).forEach((c, h) => {
    if (c) m.set(h, [pyRoundInt(c[0]), Math.trunc(c[1])]);
  });
  return [m, 'hour'];
}

function rideDow(r: Ride | undefined | null): Map<number, [number, number]> {
  const m = new Map<number, [number, number]>();
  (r?.waits?.dow ?? []).forEach((c, d) => {
    if (c) m.set(d, [pyRoundInt(c[0]), Math.trunc(c[1])]);
  });
  return m;
}

function sortedHours(h: Hourly): number[] {
  return Array.from(h.keys()).sort((a, b) => a - b);
}

/** Fix A: drop hours with < 10% of the busiest hour's samples. */
function dense(h: Hourly): Hourly {
  if (!h.size) return h;
  const peak = Math.max(...Array.from(h.values()).map((v) => v[1]));
  const floor = Math.max(
    MIN_HOUR_SAMPLES,
    Math.ceil(SPARSE_HOUR_FRACTION * peak)
  );
  return new Map(Array.from(h.entries()).filter(([, v]) => v[1] >= floor));
}

function bestHours(hourly: Hourly, k = 2): Facts[] {
  const cands = sortedHours(dense(hourly))
    .map(
      (h) =>
        [h, ...(hourly.get(h) as [number, number])] as [number, number, number]
    )
    .filter(
      ([h, , n]) => h >= HOUR_MIN && h <= HOUR_MAX && n >= MIN_HOUR_SAMPLES
    );
  cands.sort((x, y) => x[1] - y[1] || x[0] - y[0]);
  return cands
    .slice(0, k)
    .map(([h, a, n]) => ({ time: hourLabel(h), avg_wait_min: a, samples: n }));
}

function worstHour(hourly: Hourly): Facts | null {
  const cands = sortedHours(dense(hourly))
    .map(
      (h) =>
        [h, ...(hourly.get(h) as [number, number])] as [number, number, number]
    )
    .filter(
      ([h, , n]) => h >= HOUR_MIN && h <= HOUR_MAX && n >= MIN_HOUR_SAMPLES
    );
  if (!cands.length) return null;
  // Python max(): the first maximal element in hour order.
  let best = cands[0] as [number, number, number];
  for (const c of cands) if (c[1] > best[1]) best = c;
  return { time: hourLabel(best[0]), avg_wait_min: best[1], samples: best[2] };
}

function windowAvg(
  hourly: Hourly,
  tw: { start_hour: number; end_hour: number; label: string }
): Facts | null {
  const hs: number[] = [];
  for (let h = tw.start_hour; h <= tw.end_hour; h++)
    if (hourly.has(h)) hs.push(h);
  if (!hs.length) return null;
  const n = hs.reduce((s, h) => s + (hourly.get(h) as [number, number])[1], 0);
  const avg = n
    ? hs.reduce(
        (s, h) =>
          s +
          (hourly.get(h) as [number, number])[0] *
            (hourly.get(h) as [number, number])[1],
        0
      ) / n
    : hs.reduce((s, h) => s + (hourly.get(h) as [number, number])[0], 0) /
      hs.length;
  const label =
    tw.start_hour === tw.end_hour
      ? tw.label
      : `${tw.label} (${hourLabel(tw.start_hour)}-${hourLabel(tw.end_hour)})`;
  return { time: label, avg_wait_min: pyRoundInt(avg), samples: n };
}

/** bot_answer.get_hours, read from core.hours. */
export function getHours(core: Core, park: string, day: Day): Facts | null {
  const h: Hours | undefined = core.hours[park]?.days[isoDay(day)];
  if (!h) return null;
  const out: Facts = {
    open: h.open ?? null,
    close: h.close ?? null,
    early_entry: h.early_entry
      ? { open: h.early_entry.open, close: h.early_entry.close }
      : null,
    extended_evening: h.extended_evening
      ? { open: h.extended_evening.open, close: h.extended_evening.close }
      : null,
    special_events: (h.extras ?? []).map((x) => ({
      name: x.name,
      open: x.open,
      close: x.close,
    })),
  };
  if (h.open24) out._open_hour = Number(h.open24.slice(0, 2));
  if (h.close24) out._close_hour = Number(h.close24.slice(0, 2));
  if (!out.open && !out.early_entry && !out.special_events.length) return null;
  return out;
}

/** bot_answer.get_crowd, read from core.crowds. */
export function getCrowd(core: Core, park: string, day: Day): Facts | null {
  const c = core.crowds[park]?.days[isoDay(day)];
  if (!c) return null;
  return {
    crowd_level: c.level,
    label: crowdLabel(c.level),
    predicted_avg_wait_min: c.avg_wait,
    model_confidence: c.confidence,
    seasonal_periods: c.seasonal ?? [],
  };
}

/** The strategy outlook for a date: that date, else the entry with the same weekday. */
export function getOutlook(core: Core, park: string, day: Day) {
  const days = core.outlook[park]?.days ?? {};
  return (
    days[isoDay(day)] ??
    Object.values(days).find((e) => e.weekday === weekday(day)) ??
    null
  );
}

function pickView(p: {
  ride: string;
  avg_wait_at_open_min: number;
  typical_peak_wait_min: number;
  minutes_saved_vs_peak: number;
}): Facts {
  return {
    ride: p.ride,
    avg_wait_at_open_min: p.avg_wait_at_open_min,
    typical_peak_wait_min: p.typical_peak_wait_min,
    minutes_saved_vs_peak: p.minutes_saved_vs_peak,
  };
}

function pname(common: Common, pq: ParsedQuestion, p: string): string {
  return parkDisplayName(common, pq.destination, p);
}

// ---------------------------------------------------------------- facts (original intents)

function factsRideBestTime(
  common: Common,
  core: Core,
  pq: ParsedQuestion
): Facts {
  const ride = pq.ride as RideMatch;
  const r = core.rides[ride.entityId];
  const day =
    pq.dateExplicit && pq.dates.length === 1 ? (pq.dates[0] as Day) : null;
  const [hourly, basis] = rideHourly(r, day !== null ? weekday(day) : null);
  const facts: Facts = {
    type: 'ride_best_time',
    ride: ride.name,
    park: ride.parkSlug ? pname(common, pq, ride.parkSlug) : null,
    data_basis:
      basis === 'dow_hour' && day !== null
        ? `typical ${WEEKDAY_NAMES[weekday(day)]} pattern, last 90 days`
        : 'typical pattern across all days, last 90 days',
    units: 'minutes of posted standby wait (historical averages)',
  };
  if (day !== null) facts.day = fmtDay(day);
  const best = bestHours(hourly);
  if (!best.length) {
    facts._quality = 0.0;
    facts.note = 'No historical wait data for this ride.';
    return facts;
  }
  facts.lowest_wait_hours = best;
  facts.highest_wait_hour = worstHour(hourly);
  let q = sampleQuality(best.reduce((s, b) => s + b.samples, 0));
  if (pq.timeWindow) {
    const req = windowAvg(hourly, pq.timeWindow);
    if (req) {
      facts.requested_time = req;
      q = Math.min(q, sampleQuality(req.samples));
    } else {
      q = Math.min(q, 0.5);
    }
  }
  if (day === null) {
    const ranked = Array.from(rideDow(r).entries())
      .filter(([, [, n]]) => n >= 10)
      .map(([d, [a, n]]) => [d, a, n] as [number, number, number])
      .sort((x, y) => x[1] - y[1] || 0);
    if (ranked.length >= 3) {
      facts.lowest_wait_days = ranked.slice(0, 2).map(([d, a, n]) => ({
        day: WEEKDAY_NAMES[d],
        avg_wait_min: a,
        samples: n,
      }));
      const [d, a, n] = ranked[ranked.length - 1] as [number, number, number];
      facts.highest_wait_day = {
        day: WEEKDAY_NAMES[d],
        avg_wait_min: a,
        samples: n,
      };
    }
  }
  if (basis !== 'dow_hour' && day !== null) q = Math.min(q, 0.85);
  facts._quality = q;
  return facts;
}

function factsRideCurrentWait(
  common: Common,
  core: Core,
  pq: ParsedQuestion,
  now: Date
): Facts {
  const ride = pq.ride as RideMatch;
  const facts: Facts = {
    type: 'ride_current_wait',
    ride: ride.name,
    park: ride.parkSlug ? pname(common, pq, ride.parkSlug) : null,
    units: 'minutes of posted standby wait',
  };
  // The bundle has no live snapshot (the Python path with a stale live cache).
  facts.live = null;
  facts.live_available = false;
  const local = localParts(pq.destination, now);
  const [hourly, basis] = rideHourly(
    core.rides[ride.entityId],
    weekday(local.day)
  );
  const typical = hourly.get(local.hour);
  if (typical) {
    facts.typical_now = {
      time: hourLabel(local.hour),
      day:
        basis === 'dow_hour' ? WEEKDAY_NAMES[weekday(local.day)] : 'all days',
      avg_wait_min: typical[0],
      samples: typical[1],
      data_basis: 'historical average, last 90 days',
    };
    facts.note =
      'Live wait unavailable right now; only the historical typical wait is known.';
    facts._quality = 0.5;
  } else {
    facts._quality = 0.0;
  }
  return facts;
}

function factsParkCurrentWaits(common: Common, pq: ParsedQuestion): Facts {
  return {
    type: 'park_current_waits',
    park: pname(common, pq, pq.parkSlug as string),
    units: 'minutes of posted standby wait',
    live_available: false,
    _quality: 0.0,
  };
}

function factsParkBestTime(
  common: Common,
  core: Core,
  pq: ParsedQuestion
): Facts {
  const day = pq.dates[0] as Day;
  const out: Facts = {
    type: 'park_best_time',
    day: fmtDay(day),
    data_basis: `typical ${WEEKDAY_NAMES[weekday(day)]} pattern (headliner rides), last 90 days`,
    units: 'minutes of average headliner standby wait',
    parks: [],
  };
  let got = 0;
  for (const p of targetParks(common, pq)) {
    const o = getOutlook(core, p, day);
    if (!o?.peak) continue;
    const entry: Facts = {
      park: pname(common, pq, p),
      busiest_window: {
        start: o.peak.start,
        end: o.peak.end,
        avg_headliner_wait_min: o.peak.avg_headliner_wait_min,
      },
    };
    if (o.quieter) {
      entry.quieter_window = {
        start: o.quieter.start,
        end: o.quieter.end,
        avg_headliner_wait_min: o.quieter.avg_headliner_wait_min,
      };
    }
    out.parks.push(entry);
    got++;
  }
  out._quality = got ? 0.9 : 0.0;
  return out;
}

function factsRopeDrop(common: Common, core: Core, pq: ParsedQuestion): Facts {
  const day = pq.dates[0] as Day;
  const out: Facts = {
    type: 'rope_drop',
    day: fmtDay(day),
    data_basis: `typical ${WEEKDAY_NAMES[weekday(day)]} waits, last 90 days`,
    units: 'minutes',
    parks: [],
  };
  for (const p of targetParks(common, pq)) {
    const o = getOutlook(core, p, day);
    const official = (o?.rope_drop ?? []).slice(0, 3).map(pickView);
    if (!official.length) continue;
    const entry: Facts = {
      park: pname(common, pq, p),
      best_rope_drop_rides: official,
    };
    const etpe = (o?.early_entry_picks ?? []).slice(0, 2).map(pickView);
    if (
      etpe.length &&
      pq.destination === 'wdw' &&
      JSON.stringify(etpe.map((e) => e.ride)) !==
        JSON.stringify(official.slice(0, 2).map((x) => x.ride))
    ) {
      entry.early_entry_picks = etpe;
    }
    const hrs = getHours(core, p, day);
    if (hrs?.open) {
      entry.park_open = hrs.open;
      if (hrs.early_entry) entry.early_entry_open = hrs.early_entry.open;
    }
    out.parks.push(entry);
  }
  if (pq.ride) {
    const [hourly] = rideHourly(core.rides[pq.ride.entityId], weekday(day));
    const okHours = sortedHours(hourly).filter(
      (h) =>
        h >= 7 && (hourly.get(h) as [number, number])[1] >= MIN_HOUR_SAMPLES
    );
    const openH = okHours.length ? (okHours[0] as number) : null;
    const worst = worstHour(hourly);
    if (openH !== null && worst) {
      out.asked_ride = {
        ride: pq.ride.name,
        avg_wait_first_hour_min: (hourly.get(openH) as [number, number])[0],
        first_hour: hourLabel(openH),
        highest_wait_hour: worst,
      };
    }
  }
  out._quality = out.parks.length ? 0.9 : out.asked_ride ? 0.6 : 0.0;
  return out;
}

function rideOpenVsLater(
  core: Core,
  ride: RideMatch,
  park: string,
  day: Day | null
): Facts | null {
  const [hourly, basis] = rideHourly(
    core.rides[ride.entityId],
    day !== null ? weekday(day) : null
  );
  const ok = new Map(
    Array.from(hourly.entries()).filter(
      ([h, v]) => h >= 7 && v[1] >= MIN_HOUR_SAMPLES
    )
  );
  if (!ok.size) return null;
  let openH: number | null = null;
  if (day !== null) {
    const hrs = getHours(core, park, day) ?? {};
    if (hrs._open_hour !== undefined && ok.has(hrs._open_hour))
      openH = hrs._open_hour;
  }
  if (openH === null) openH = Math.min(...ok.keys());
  const oh = openH;
  const laterH = [2, 3, 1].map((k) => oh + k).find((h) => ok.has(h));
  if (laterH === undefined) return null;
  const [a, na] = ok.get(oh) as [number, number];
  const [b, nb] = ok.get(laterH) as [number, number];
  return {
    ride: ride.name,
    at_open: { time: hourLabel(oh), avg_wait_min: a },
    later: { time: hourLabel(laterH), avg_wait_min: b },
    climb_min: b - a,
    _samples: na + nb,
    _basis: basis,
  };
}

type DayType = 'weekday' | 'weekend' | 'all';

function rushCells(
  r: Ride | undefined,
  dt: DayType
): [[number, number], [number, number]] | null {
  const cells = r?.rush?.open?.[dt] ?? [];
  if (cells.length <= RUSH_LATER_CELL) return null;
  const a = cells[RUSH_OPEN_CELL];
  const b = cells[RUSH_LATER_CELL];
  return a && b ? [a, b] : null;
}

const DT_LABEL: Record<DayType, string> = {
  weekday: 'on a typical weekday',
  weekend: 'on a typical weekend day',
  all: 'on a typical day',
};

/**
 * bot_answer.facts_compare_rides with fix B: per park group, the opening-rush
 * profile (first 15 min after the official open vs 2 h later) when every ride
 * in the group has both cells for the day type (weekday/weekend from the
 * date, else "all"); otherwise the old hour-of-day comparison.
 */
function factsCompareRides(
  common: Common,
  core: Core,
  pq: ParsedQuestion
): Facts {
  const day = pq.dateExplicit && pq.dates.length ? (pq.dates[0] as Day) : null;
  const rides = pq.rides.slice(0, MAX_COMPARE_RIDES);
  let groups = new Map<string, RideMatch[]>();
  for (const r of rides) {
    const k = r.parkSlug ?? '';
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  if (
    (pq.parkSource === 'explicit' || pq.parkSource === 'context') &&
    (groups.get(pq.parkSlug ?? '') ?? []).length >= 2
  ) {
    groups = new Map([
      [pq.parkSlug as string, groups.get(pq.parkSlug as string) as RideMatch[]],
    ]);
  }
  const out: Facts = {
    type: 'compare_rides',
    units: 'minutes of posted standby wait (historical averages)',
    data_basis:
      day !== null
        ? `typical ${WEEKDAY_NAMES[weekday(day)]} pattern, last 90 days`
        : 'typical pattern across all days, last 90 days',
    parks: [],
  };
  if (day !== null) out.day = fmtDay(day);
  const qs: number[] = [];
  const rushTypes = new Set<DayType>();
  for (const [park, grp] of groups) {
    if (grp.length < 2 || !park) continue;
    const rows: Facts[] = [];
    const missing: string[] = [];
    const tried: DayType[] = [
      ...(day !== null
        ? ([weekday(day) >= 5 ? 'weekend' : 'weekday'] as DayType[])
        : []),
      'all',
    ];
    let dtUsed: DayType | null = null;
    for (const dt of tried) {
      const cells = grp.map((r) => rushCells(core.rides[r.entityId], dt));
      if (cells.every((c) => c)) {
        dtUsed = dt;
        grp.forEach((r, i) => {
          const [[a, na], [b, nb]] = cells[i] as [
            [number, number],
            [number, number],
          ];
          rows.push({
            ride: r.name,
            at_open: { time: 'opening', avg_wait_min: a },
            later: { time: '2 hours after opening', avg_wait_min: b },
            climb_min: b - a,
            _samples: na + nb,
            _basis: `rush:${dt}`,
          });
        });
        break;
      }
    }
    if (dtUsed === null) {
      for (const r of grp) {
        const row = rideOpenVsLater(core, r, park, day);
        if (row) rows.push(row);
        else missing.push(r.name);
      }
    } else {
      rushTypes.add(dtUsed);
    }
    if (rows.length < 2) continue;
    const ranked = rows
      .map((x, i) => ({ x, i }))
      .sort((p, q) => q.x.climb_min - p.x.climb_min || p.i - q.i)
      .map((p) => p.x);
    const entry: Facts = {
      park: pname(common, pq, park),
      rides: rows.map((x) =>
        Object.fromEntries(
          Object.entries(x).filter(([k]) => !k.startsWith('_'))
        )
      ),
    };
    const top = (ranked[0] as Facts).climb_min as number;
    if (top >= 10) {
      const first = ranked
        .filter((x) => x.climb_min >= top - 5)
        .map((x) => x.ride as string);
      if (first.length < ranked.length) {
        entry.do_first = first;
        entry.later = ranked
          .filter((x) => !first.includes(x.ride))
          .map((x) => x.ride);
      }
    } else {
      entry.steady = true;
    }
    if (missing.length) entry.no_data = missing;
    let q = Math.min(...rows.map((x) => sampleQuality(x._samples)));
    if (entry.steady) q = Math.min(q, 0.6);
    if (
      day !== null &&
      rows.some(
        (x) => !['dow_hour', 'rush:weekday', 'rush:weekend'].includes(x._basis)
      )
    ) {
      q = Math.min(q, 0.85);
    }
    if (missing.length) q *= 0.9;
    qs.push(q);
    out.parks.push(entry);
  }
  if (rushTypes.size) {
    const dt: DayType =
      rushTypes.size === 1 ? (Array.from(rushTypes)[0] as DayType) : 'all';
    out.units =
      'minutes of posted standby wait (median, first 15 min after the official opening vs 2 h later)';
    out.data_basis = `opening-rush profile, ${dt} days, last ${RUSH_WINDOW_DAYS} days`;
    out.lead = `Over the last ${RUSH_WINDOW_DAYS} days ${DT_LABEL[dt]}`;
  }
  out._quality = qs.length ? Math.min(...qs) : 0.0;
  return out;
}

/**
 * "Sep 20" when the data was built before the park-local today of the
 * question (an older snapshot): date-bound answers then say how old their
 * schedule/forecast is instead of presenting it as current. null when fresh.
 */
export function staleAsOf(core: Core, pq: ParsedQuestion): string | null {
  return core.local_date && core.local_date < isoDay(pq.today)
    ? shortIso(core.local_date)
    : null;
}

/** Longer than this, crowd answers rank weeks instead of listing days. */
export const WEEK_MODE_MIN_DAYS = 15;

/**
 * "What weeks are least busy this winter?" (2026-10-24): over a month or a season the
 * day list only ever showed the first 7 days. Rank Sunday-to-Saturday weeks by their
 * average predicted level across the asked parks instead (a week needs >= 4 days with
 * a forecast), and say where the forecast stops.
 */
function factsCrowdWeeks(common: Common, core: Core, pq: ParsedQuestion): Facts {
  const parks = targetParks(common, pq);
  const out: Facts = {
    type: 'crowd_weeks',
    scale: '1 (quietest) to 10 (busiest)',
    data_basis: 'prediction from historical wait-time data (not live)',
    period: pq.dateLabel ?? `${fmtDay(pq.dates[0] as Day)} to ${fmtDay(pq.dates[pq.dates.length - 1] as Day)}`,
    parks: parks.map((p) => pname(common, pq, p)),
    scope:
      parks.length === 1
        ? pname(common, pq, parks[0] as string)
        : `${common.destinations[pq.destination]?.name ?? pq.destination}'s ${parks.length} parks`,
    weeks: [],
  };
  const asOf = staleAsOf(core, pq);
  if (asOf) out.as_of = asOf;
  const byWeek = new Map<Day, { days: Set<Day>; levels: number[]; conf: string[] }>();
  let lastWithData: Day | null = null;
  for (const d of pq.dates) {
    const sun = d - ((weekday(d) + 1) % 7); // the Sunday starting d's week (weekday(): Mon=0..Sun=6)
    for (const p of parks) {
      const c = getCrowd(core, p, d);
      if (!c) continue;
      const w = byWeek.get(sun) ?? { days: new Set<Day>(), levels: [], conf: [] };
      w.days.add(d);
      w.levels.push(c.crowd_level);
      w.conf.push(String(c.model_confidence));
      byWeek.set(sun, w);
      if (lastWithData === null || d > lastWithData) lastWithData = d;
    }
  }
  const weeks: Facts[] = [];
  const confs: string[] = [];
  for (const [sun, w] of Array.from(byWeek.entries()).sort((a, b) => a[0] - b[0])) {
    if (w.days.size < 4) continue;
    const avg = pyRound(w.levels.reduce((a, b) => a + b, 0) / w.levels.length, 1);
    const label = fmtDay(Math.max(sun, pq.dates[0] as Day));
    weeks.push({ week_of: label.slice(label.indexOf(', ') + 2), avg_level: avg, days: w.days.size }); // "Jan 10"
    confs.push(...w.conf);
  }
  out.weeks = weeks;
  const lastAsked = pq.dates[pq.dates.length - 1] as Day;
  if (lastWithData !== null && lastWithData < lastAsked) out.forecast_through = fmtDay(lastWithData);
  if (weeks.length >= 2) {
    const sorted = [...weeks].sort((a, b) => a.avg_level - b.avg_level);
    out.quietest_weeks = sorted.slice(0, 3);
    out.busiest_week = sorted[sorted.length - 1];
  }
  const confQ: Record<string, number> = { high: 1.0, medium: 0.85, low: 0.6 };
  out._quality =
    weeks.length >= 2 ? Math.min(...Array.from(new Set(confs)).map((c) => confQ[c] ?? 0.6)) : 0.0;
  return out;
}

function factsCrowds(common: Common, core: Core, pq: ParsedQuestion): Facts {
  if (pq.dates.length >= WEEK_MODE_MIN_DAYS) return factsCrowdWeeks(common, core, pq);
  const parks = targetParks(common, pq);
  const dates = pq.dates.slice(
    0,
    Math.min(14, Math.max(7, Math.floor(28 / Math.max(1, parks.length))))
  );
  const out: Facts = {
    type: 'crowd_forecast',
    scale: '1 (quietest) to 10 (busiest)',
    data_basis: 'prediction from historical wait-time data (not live)',
    forecasts: [],
  };
  const asOf = staleAsOf(core, pq);
  if (asOf) out.as_of = asOf;
  for (const d of dates) {
    for (const p of parks) {
      const c = getCrowd(core, p, d);
      if (!c) continue;
      const f: Facts = {
        date: fmtDay(d),
        park: pname(common, pq, p),
        crowd_level: c.crowd_level,
        label: c.label,
        predicted_avg_wait_min: c.predicted_avg_wait_min,
        model_confidence: c.model_confidence,
      };
      if (c.seasonal_periods.length) f.seasonal_events = c.seasonal_periods;
      out.forecasts.push(f);
    }
  }
  const fc: Facts[] = out.forecasts;
  if (fc.length > 1) {
    let lo = fc[0] as Facts;
    let hi = fc[0] as Facts;
    for (const f of fc) {
      if (f.crowd_level < lo.crowd_level) lo = f;
      if (f.crowd_level > hi.crowd_level) hi = f;
    }
    out.quietest = {
      date: lo.date,
      park: lo.park,
      crowd_level: lo.crowd_level,
    };
    out.busiest = { date: hi.date, park: hi.park, crowd_level: hi.crowd_level };
    const perPark: Facts = {};
    for (const f of fc) {
      const cur = perPark[f.park];
      if (cur === undefined || f.crowd_level < cur.crowd_level) {
        perPark[f.park] = { date: f.date, crowd_level: f.crowd_level };
      }
    }
    if (new Set(fc.map((f) => f.date)).size > 1) out.quietest_by_park = perPark;
  }
  if (!fc.length) out._quality = 0.0;
  else {
    const confQ: Record<string, number> = { high: 1.0, medium: 0.85, low: 0.6 };
    out._quality = Math.min(...fc.map((f) => confQ[f.model_confidence] ?? 0.6));
  }
  return out;
}

function factsHours(common: Common, core: Core, pq: ParsedQuestion): Facts {
  const parks = targetParks(common, pq);
  const dates =
    parks.length === 1 ? pq.dates.slice(0, 7) : pq.dates.slice(0, 2);
  const out: Facts = {
    type: 'park_hours',
    note: 'Published Disney hours; subject to change.',
    days: [],
  };
  const asOf = staleAsOf(core, pq);
  if (asOf) out.as_of = asOf;
  for (const d of dates) {
    for (const p of parks) {
      const h = getHours(core, p, d);
      if (!h) continue;
      const entry: Facts = { date: fmtDay(d), park: pname(common, pq, p) };
      for (const [k, v] of Object.entries(h)) {
        if (!k.startsWith('_') && v && !(Array.isArray(v) && !v.length))
          entry[k] = v;
      }
      out.days.push(entry);
    }
  }
  out._quality = out.days.length ? 1.0 : 0.0;
  return out;
}

async function retrieveFacts(
  env: AnswerEnv,
  pq: ParsedQuestion
): Promise<Facts> {
  const core = await env.src.core(pq.destination);
  if (!core) return { type: 'none', _quality: 0.0 };
  const it = pq.intent;
  if (EXTRA_INTENTS.has(it)) return extraFacts(env, core, pq);
  if (it === 'current_wait') {
    if (pq.ride) return factsRideCurrentWait(env.common, core, pq, env.now);
    if (pq.parkSlug) return factsParkCurrentWaits(env.common, pq);
    return { type: 'none', _quality: 0.0 };
  }
  if (it === 'best_time') {
    return pq.ride
      ? factsRideBestTime(env.common, core, pq)
      : factsParkBestTime(env.common, core, pq);
  }
  if (it === 'rope_drop') return factsRopeDrop(env.common, core, pq);
  if (it === 'compare_rides') return factsCompareRides(env.common, core, pq);
  if (it === 'crowds_on_date') return factsCrowds(env.common, core, pq);
  if (it === 'park_hours') return factsHours(env.common, core, pq);
  return { type: 'none', _quality: 0.0 };
}

export function publicFacts(o: any): any {
  if (Array.isArray(o)) return o.map(publicFacts);
  if (o && typeof o === 'object') {
    return Object.fromEntries(
      Object.entries(o)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, publicFacts(v)])
    );
  }
  return o;
}

// ---------------------------------------------------------------- links

async function buildLinks(
  env: AnswerEnv,
  pq: ParsedQuestion,
  facts: Facts
): Promise<Link[]> {
  const core = await env.src.core(pq.destination);
  if (!core) return [];
  if (EXTRA_INTENTS.has(pq.intent)) return extraLinks(env, core, pq, facts);
  const links: Link[] = [];
  const add = (title: string, url: string | null | undefined) => {
    if (!url) return;
    if (links.length < 3 && !links.some((l) => l.url === url))
      links.push({ title, url });
  };
  const ride = pq.ride;
  const r = ride ? core.rides[ride.entityId] : undefined;
  const ridePages = !!(ride && ride.slug);
  const rideData = ridePages && hasWaitData(r);
  const park = pq.parkSlug;
  const pn = park ? pname(env.common, pq, park) : null;
  const purl = (p: string, k: string) => core.parks[p]?.urls[k];
  const it = pq.intent;

  if (
    rideData &&
    ride &&
    r &&
    ['current_wait', 'best_time', 'rope_drop', 'crowds_on_date'].includes(it)
  ) {
    if (it === 'current_wait') {
      add(`${ride.name} wait times`, r.urls.wait_times);
      add(`Best time to ride ${ride.name}`, r.urls.best_time);
    } else {
      add(`Best time to ride ${ride.name}`, r.urls.best_time);
      add(`${ride.name} wait times`, r.urls.wait_times);
    }
  }
  if (it === 'compare_rides') {
    if (park) add(`${pn} rope drop strategy`, purl(park, 'rope_drop'));
    for (const x of pq.rides.slice(0, MAX_COMPARE_RIDES)) {
      const xr = core.rides[x.entityId];
      if (x.slug && hasWaitData(xr))
        add(`Best time to ride ${x.name}`, xr?.urls.best_time);
    }
    return links.slice(0, 3);
  }
  if (it === 'rope_drop' && park) {
    const u = purl(park, 'rope_drop');
    if (u) links.unshift({ title: `${pn} rope drop strategy`, url: u });
    links.splice(3);
  } else if (it === 'rope_drop') {
    const first = parkSlugs(env.common, pq.destination)[0];
    if (first) add('Rope drop strategy by park', purl(first, 'rope_drop'));
  }
  if (it === 'crowds_on_date') {
    if (pq.parks.length > 1) {
      for (const p of pq.parks.slice(0, 2)) {
        add(
          `${pname(env.common, pq, p)} crowds by day of week`,
          purl(p, 'crowd_by_day')
        );
      }
    } else if (park) {
      add(`${pn} crowds by day of week`, purl(park, 'crowd_by_day'));
    }
    add('Crowd calendar', core.urls.crowd_calendar);
  }
  if (it === 'park_hours') {
    for (const p of targetParks(env.common, pq))
      add(`${pname(env.common, pq, p)} park hours`, purl(p, 'hours'));
  }
  if (it === 'best_time' && !ride && park) {
    add(`Best time to visit ${pn}`, purl(park, 'best_time'));
    add(`${pn} wait times`, purl(park, 'wait_times'));
  }
  if (it === 'current_wait' && park)
    add(`${pn} wait times`, purl(park, 'wait_times'));
  if (ridePages && ride && links.length < 3) add(ride.name, r?.urls.page);
  return links.slice(0, 3);
}

// ---------------------------------------------------------------- templates

function shortDay(label: string): string {
  const i = label.indexOf(', ');
  if (i < 0) return label.slice(0, 3).trim();
  return `${label.slice(0, i).slice(0, 3)} ${label.slice(i + 2)}`.trim();
}

function crowdList(facts: Facts): string {
  const fc: Facts[] = facts.forecasts ?? [];
  const byPark = new Map<string, Facts[]>();
  for (const f of fc) byPark.set(f.park, [...(byPark.get(f.park) ?? []), f]);
  const multiDay = new Set(fc.map((f) => f.date)).size > 1;
  const segs: string[] = [];
  for (const [park, rows] of Array.from(byPark.entries()).slice(0, 4)) {
    let shown = rows;
    if (rows.length > 6) {
      // Python sorts by (level, date-label string).
      const lo = [...rows]
        .sort(
          (a, b) =>
            a.crowd_level - b.crowd_level ||
            (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
        )
        .slice(0, 3);
      let hi = rows[0] as Facts;
      for (const f of rows) if (f.crowd_level > hi.crowd_level) hi = f;
      shown = rows.filter((f) => lo.includes(f) || f === hi);
    }
    const vals = shown
      .map((f) => `${shortDay(f.date)} ${f.crowd_level}/10`)
      .join(', ');
    const r0 = rows[0] as Facts;
    let seg = multiDay
      ? `${park}: ${vals}`
      : `${park} ${shortDay(r0.date)} ${r0.crowd_level}/10`;
    if (multiDay && rows.length > 1) {
      let lo = rows[0] as Facts;
      for (const f of rows) if (f.crowd_level < lo.crowd_level) lo = f;
      const ties = rows.filter((f) => f.crowd_level === lo.crowd_level);
      seg +=
        ties.length === 1
          ? ` (lowest: ${shortDay(lo.date)})`
          : ties.length === rows.length
            ? ' (about the same on each day)'
            : ` (lowest: ${ties.slice(0, 3).map((f) => shortDay(f.date)).join(', ')}${ties.length > 3 ? ' and others' : ''})`;
    }
    segs.push(seg);
  }
  let s = `Predicted crowd levels (1-10, from historical wait data): ${segs.join('; ')}.`;
  if (!multiDay && fc.length > 1) {
    const q = facts.quietest;
    if (q && fc.filter((f) => f.crowd_level === q.crowd_level).length === 1)
      s += ` Quietest: ${q.park}.`;
  }
  return s;
}

function compareText(facts: Facts): string {
  const bits: string[] = [];
  const day: string | undefined = facts.day;
  const lead = day
    ? `Historically on a typical ${day.split(',')[0]}`
    : 'Historically';
  const parks: Facts[] = facts.parks ?? [];
  for (const p of parks) {
    const rows: Facts[] = p.rides;
    const sameTimes =
      new Set(rows.map((r) => `${r.at_open.time}|${r.later.time}`)).size === 1;
    const segs = rows.map((r, i) =>
      i === 0 || !sameTimes
        ? `${r.ride} climbs from ~${r.at_open.avg_wait_min} min at ${r.at_open.time} to ~${r.later.avg_wait_min} by ${r.later.time}`
        : `${r.ride} from ~${r.at_open.avg_wait_min} to ~${r.later.avg_wait_min}`
    );
    let s = segs.join(', ');
    const first: string[] = p.do_first ?? [];
    const later: string[] = p.later ?? [];
    if (first.length === 1) s += `, so ${first[0]} first saves the most`;
    else if (first.length) {
      s += `, so ${first.slice(0, -1).join(', ')} and ${first[first.length - 1]} climb the most; do them before ${later.join(', ')}`;
    } else if (p.steady) {
      s +=
        '; none of them climbs much, so the order matters less than being there at open';
    } else {
      s +=
        '; they climb by similar amounts, so the order matters less than being there at open';
    }
    if (p.no_data) s += ` (no wait history for ${p.no_data.join(', ')})`;
    bits.push((parks.length > 1 ? `at ${p.park}, ` : '') + s);
  }
  if (!bits.length)
    return "I don't have enough wait history to compare those rides.";
  return `${facts.lead ?? lead}, ${bits.join('; ')}.`;
}

function templateAnswer(pq: ParsedQuestion, facts: Facts): string {
  const t = facts.type;
  if (EXTRA_INTENTS.has(pq.intent)) return extraTemplate(pq, facts);
  if (t === 'ride_current_wait') {
    const typ = facts.typical_now;
    const parts: string[] = [];
    if (typ)
      parts.push(
        `Historically it averages about ${typ.avg_wait_min} minutes around ${typ.time}.`
      );
    return (
      parts.join(' ') || `I don't have wait data for ${facts.ride} right now.`
    );
  }
  if (t === 'ride_best_time') {
    const best: Facts[] = facts.lowest_wait_hours ?? [];
    if (!best.length)
      return `I don't have enough wait history for ${facts.ride} yet.`;
    const b0 = best[0] as Facts;
    const req = facts.requested_time;
    const worst = facts.highest_wait_hour;
    if (req) {
      const on = facts.day ? ` on a typical ${facts.day.split(',')[0]}` : '';
      const tw = pq.timeWindow;
      const lbl = tw?.label ?? '';
      const prep =
        tw && tw.start_hour === tw.end_hour
          ? 'around'
          : ['lunch', 'lunchtime', 'midday', 'night', 'late night'].includes(
                lbl
              )
            ? 'at'
            : lbl.startsWith('after ') ||
                lbl.startsWith('before ') ||
                lbl === 'tonight'
              ? ''
              : 'in the';
      const when = `${prep} ${req.time}`.trim();
      let s =
        `Historically, ${facts.ride} averages about ${req.avg_wait_min} min ${when}${on}. ` +
        `Its shortest waits are around ${b0.time} (about ${b0.avg_wait_min} min)`;
      s += worst
        ? ` and it peaks around ${worst.time} (about ${worst.avg_wait_min} min).`
        : '.';
      return s;
    }
    let s = `Historically, ${facts.ride} has its shortest waits around ${b0.time} (about ${b0.avg_wait_min} min`;
    s += facts.day ? ` on a typical ${facts.day.split(',')[0]}).` : ').';
    if (worst)
      s += ` Waits peak around ${worst.time} (about ${worst.avg_wait_min} min).`;
    const days = facts.lowest_wait_days;
    if (days) s += ` Lightest day: ${days[0].day}.`;
    return s;
  }
  if (t === 'park_current_waits')
    return `Live waits for ${facts.park} aren't available right now.`;
  if (t === 'park_best_time') {
    const bits = (facts.parks as Facts[]).slice(0, 4).map((p) => {
      let b = `${p.park}: busiest ${p.busiest_window.start}-${p.busiest_window.end}`;
      if (p.quieter_window)
        b += `, quieter ${p.quieter_window.start}-${p.quieter_window.end}`;
      return b;
    });
    return bits.length
      ? `Typical pattern for ${facts.day} — ${bits.join('; ')}.`
      : "I don't have enough historical data to call the quiet times for that park.";
  }
  if (t === 'rope_drop') {
    const bits = (facts.parks as Facts[]).slice(0, 4).map((p) => {
      const top = p.best_rope_drop_rides[0];
      return `${p.park}: ${top.ride} (about ${top.avg_wait_at_open_min} min at open vs ${top.typical_peak_wait_min} min at peak)`;
    });
    if (!bits.length && facts.asked_ride) {
      const a = facts.asked_ride;
      return (
        `${a.ride} typically averages ${a.avg_wait_first_hour_min} min around ${a.first_hour} ` +
        `vs ${a.highest_wait_hour.avg_wait_min} min around ${a.highest_wait_hour.time}.`
      );
    }
    return bits.length
      ? `Best rope-drop picks based on historical waits — ${bits.join('; ')}.`
      : "I don't have enough data for a rope-drop pick there.";
  }
  if (t === 'crowd_weeks') {
    const q: Facts[] = facts.quietest_weeks ?? [];
    if (!q.length) return "I don't have crowd predictions that far ahead yet.";
    const scope = facts.scope;
    const list = q.map((w) => `week of ${w.week_of} (${w.avg_level})`).join(', ');
    const b: Facts = facts.busiest_week;
    let s =
      `Quietest weeks for ${facts.period}, by average predicted crowd level (1-10) at ${scope}: ` +
      `${list}. Busiest: week of ${b.week_of} (${b.avg_level}).`;
    if (facts.forecast_through) s += ` Forecasts currently run through ${facts.forecast_through}.`;
    if (facts.as_of) s += ` (Forecast as of ${facts.as_of}.)`;
    return s;
  }
  if (t === 'crowd_forecast') {
    const fc: Facts[] = facts.forecasts ?? [];
    if (!fc.length) return "I don't have a crowd prediction for that date yet.";
    const asOf = facts.as_of ? ` (Forecast as of ${facts.as_of}.)` : '';
    if (fc.length === 1) {
      const f = fc[0] as Facts;
      return (
        `Predicted crowd level for ${f.park} on ${f.date}: ${f.crowd_level}/10 (${f.label}), ` +
        `based on historical wait data.${asOf}`
      );
    }
    return crowdList(facts) + asOf;
  }
  if (t === 'park_hours') {
    const days: Facts[] = facts.days ?? [];
    if (!days.length) return "I don't have published hours for that date yet.";
    const bits = days.slice(0, 4).map((d) => {
      let b = `${d.park} ${d.date}: ${d.open ?? '?'}-${d.close ?? '?'}`;
      if (d.early_entry) b += ` (Early Entry from ${d.early_entry.open})`;
      return b;
    });
    // Older data: say how old the schedule is instead of presenting it as current.
    const tail = facts.as_of
      ? `That's Disney's published schedule as of ${facts.as_of}; hours can change, so double-check before you go.`
      : 'Hours can change, so double-check before you go.';
    return `${bits.join('; ')}. ${tail}`;
  }
  if (t === 'compare_rides') return compareText(facts);
  return "Sorry — I couldn't find data to answer that one.";
}

// ---------------------------------------------------------------- number guard

const NUM_RE = /\d+(?:\.\d+)?/g;
const URL_RE = /https?:\/\/\S+/g;

function numbersIn(text: string): number[] {
  return Array.from((text ?? '').replace(URL_RE, ' ').matchAll(NUM_RE)).map(
    (m) => Number(m[0])
  );
}

function allowedNumbers(facts: Facts, question: string): Set<number> {
  const vals: number[] = [];
  const walk = (o: any) => {
    if (typeof o === 'boolean' || o === null || o === undefined) return;
    if (typeof o === 'number') vals.push(o);
    else if (typeof o === 'string') vals.push(...numbersIn(o));
    else if (Array.isArray(o)) o.forEach(walk);
    else if (typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk(publicFacts(facts));
  vals.push(...numbersIn(question));
  const out = new Set<number>();
  for (const v of vals) {
    [v, pyRound(v), Math.floor(v), Math.ceil(v), pyRound(v, 1)].forEach((x) =>
      out.add(x)
    );
    if (Number.isInteger(v)) {
      if (v >= 13 && v <= 23) out.add(v - 12);
      if (v >= 1 && v <= 11) out.add(v + 12);
      if (v === 0 || v === 12 || v === 24) {
        out.add(0);
        out.add(12);
      }
    }
  }
  if (facts.type === 'crowd_forecast' || facts.type === 'crowd_weeks') {
    out.add(1);
    out.add(10);
  }
  out.add(0);
  return out;
}

export function numberGuard(
  answer: string,
  facts: Facts,
  question: string
): number[] {
  const allowed = allowedNumbers(facts, question);
  return numbersIn(answer).filter((n) => !allowed.has(n));
}

// ---------------------------------------------------------------- confidence

export function parseScore(pq: ParsedQuestion): number {
  if (!pq.supported) return 0.0;
  if (pq.intent === 'other' || !pq.intentKeyword) return 0.15;
  const it = pq.intent;
  let s: number;
  if (EXTRA_INTENTS.has(it)) {
    s = extraParseScore(pq);
  } else if (it === 'current_wait' || it === 'best_time') {
    if (pq.ride) s = pq.ride.score;
    else if (pq.parkSlug)
      s =
        pq.parkSource === 'explicit' || pq.parkSource === 'context'
          ? 0.85
          : 0.7;
    else s = 0.3;
  } else if (it === 'rope_drop') {
    s = pq.parkSlug ? 1.0 : 0.8;
  } else if (it === 'compare_rides') {
    const rides = pq.rides.slice(0, MAX_COMPARE_RIDES);
    s = rides.length ? Math.min(...rides.map((r) => r.score)) : 0.0;
    if (new Set(rides.map((r) => r.parkSlug)).size > 1) s *= 0.9;
  } else {
    s = pq.parkSlug ? 1.0 : 0.85;
  }
  if (pq.rideAliasUnresolved && !pq.ride) s = Math.min(s, 0.4);
  if (pq.periodUnresolved) s = Math.min(s, 0.3); // never answer a period as "today"
  if (!pq.destinationExplicit && !pq.parkSlug && !pq.ride) s *= 0.95;
  return s;
}

export function computeConfidence(
  pq: ParsedQuestion,
  facts: Facts,
  invented: number[],
  usedFallback: boolean
): number {
  if (!pq.supported) return 0.05;
  const ps = parseScore(pq);
  const fq = Number(facts._quality ?? 0) || 0;
  let conf: number;
  if (pq.intent === 'other') conf = 0.1;
  else if (fq <= 0) conf = Math.min(0.3, 0.15 * ps + 0.1);
  else conf = 0.15 + 0.85 * ps * fq;
  if (usedFallback) conf *= 0.95;
  if (invented.length) conf = Math.min(conf, GUARD_CONFIDENCE_CAP);
  return pyRound(Math.max(0.0, Math.min(conf, 0.95)), 2);
}

// ---------------------------------------------------------------- parts / posts

export const MAX_PARTS = 3;
export const MAX_REPLY_WORDS = 160;
export const MAIN_UNANSWERED_CAP = 0.5;

function partLabel(pq: ParsedQuestion): string {
  const it = pq.intent;
  const ride = pq.ride ? pq.ride.name : null;
  if (EXTRA_LABELS[it]) return EXTRA_LABELS[it] as string;
  if (it === 'compare_rides') return 'Ride order';
  if (it === 'best_time')
    return ride ? `${ride} timing` : 'Busy vs. quiet times';
  if (it === 'current_wait') return ride ? `${ride} wait` : 'Current waits';
  const m: Record<string, string> = {
    rope_drop: 'Rope drop',
    crowds_on_date: 'Crowds',
    park_hours: 'Park hours',
  };
  return m[it] ?? 'Answer';
}

const OTHER_ANSWER =
  "Sorry — I'm not sure how to answer that one. Try asking about a ride's wait, the best " +
  'time to ride, rope drop, crowds on a date, or park hours.';

export async function answerPart(
  env: AnswerEnv,
  question: string,
  pq: ParsedQuestion
): Promise<Part> {
  let facts: Facts;
  try {
    facts = await retrieveFacts(env, pq);
  } catch (err) {
    console.warn(
      `[bot] fact retrieval failed (intent=${pq.intent}): ${err instanceof Error ? err.name : 'error'}`
    );
    facts = { type: 'none', _quality: 0.0 };
  }
  let usedFallback = false;
  let answer: string;
  if (pq.intent !== 'other' && (facts._quality ?? 0) > 0) {
    answer = templateAnswer(pq, facts);
  } else if (pq.intent === 'other') {
    usedFallback = true;
    answer = OTHER_ANSWER;
  } else {
    usedFallback = true;
    answer = templateAnswer(pq, facts);
  }
  answer = cpSlice(answer, 1200);
  const invented = numberGuard(answer, facts, question);
  const confidence = computeConfidence(pq, facts, invented, usedFallback);
  return {
    answer,
    confidence,
    intent: pq.intent,
    links: confidence > 0.1 ? await buildLinks(env, pq, facts) : [],
    label: partLabel(pq),
    pq,
    guardViolations: invented.length,
  };
}

function mergeLinks(parts: Part[]): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    for (const p of parts) {
      const l = p.links[i];
      if (l && !seen.has(l.url) && out.length < 3) {
        seen.add(l.url);
        out.push(l);
      }
    }
  }
  return out;
}

/**
 * bot_answer.analyze_post: the whole post/comment ("title\n\nbody").
 * No question sentence -> confidence 0. Each question is parsed on its own
 * (inheriting destination/park/dates from the post); several questions ->
 * up to MAX_PARTS answered parts, silent when the main (first) one can't be
 * answered.
 */
export async function analyzePost(
  env: AnswerEnv,
  text: string
): Promise<PostResult> {
  const threshold = env.threshold ?? DEFAULT_BOT_THRESHOLD;
  const [sents, qidx] = questionSentences(text);
  if (!qidx.length) {
    return {
      answer: '',
      confidence: 0.0,
      links: [],
      intent: 'no_question',
      parts: [],
      nQuestions: 0,
    };
  }
  const penv: ParseEnv = {
    common: env.common,
    core: (d: Dest) => env.src.core(d),
    today: (d: Dest) => env.today ?? localToday(d, env.now),
  };
  let parts: Part[];
  if (sents.length === 1) {
    const pq = await parseQuestion(penv, sents[0] as string);
    parts = [await answerPart(env, sents[0] as string, pq)];
  } else {
    const clean = stripMentions(text);
    let ctx = buildContext(
      env.common,
      clean,
      env.today ?? localToday('wdw', env.now)
    );
    if (
      env.today === undefined &&
      ctx.destination &&
      ctx.destination !== 'wdw'
    ) {
      ctx = buildContext(
        env.common,
        clean,
        localToday(ctx.destination, env.now)
      );
    }
    parts = [];
    for (const i of qidx) {
      const prev: string[] = [];
      for (let j = i - 1; j > Math.max(-1, i - 5); j--) {
        if (qidx.includes(j)) break;
        prev.push(sents[j] as string);
      }
      const pq = await parseQuestion(penv, sents[i] as string, ctx, prev);
      parts.push(await answerPart(env, sents[i] as string, pq));
    }
  }

  if (parts.length === 1) {
    const p = parts[0] as Part;
    return {
      answer: p.answer,
      confidence: p.confidence,
      links: p.links,
      intent: p.intent,
      parts,
      nQuestions: 1,
    };
  }
  const n = parts.length;
  const answered = parts.filter((p) => p.confidence >= threshold);
  let shown = answered.slice(0, MAX_PARTS);
  while (
    shown.length > 1 &&
    shown.reduce((s, p) => s + wordCount(p.answer), 0) > MAX_REPLY_WORDS
  ) {
    shown = shown.slice(0, -1);
  }
  if (!shown.length) {
    const best = Math.max(...parts.map((p) => p.confidence));
    return {
      answer: '',
      confidence: pyRound(Math.min(best, 0.3), 2),
      links: [],
      intent: 'other',
      parts,
      nQuestions: n,
    };
  }
  const coverage = shown.length / n;
  let conf =
    Math.min(...shown.map((p) => p.confidence)) * (0.6 + 0.4 * coverage);
  if ((parts[0] as Part).confidence < threshold)
    conf = Math.min(conf, MAIN_UNANSWERED_CAP);
  const answer =
    shown.length === 1
      ? (shown[0] as Part).answer
      : shown.map((p) => `**${p.label}:** ${p.answer}`).join('\n\n');
  return {
    answer: cpSlice(answer, 1500),
    confidence: pyRound(Math.max(0.0, Math.min(conf, 0.95)), 2),
    links: mergeLinks(shown),
    intent: shown.length === 1 ? (shown[0] as Part).intent : 'multi',
    parts,
    nQuestions: n,
  };
}
