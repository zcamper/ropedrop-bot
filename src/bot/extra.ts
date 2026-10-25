/* eslint-disable @typescript-eslint/no-explicit-any */
// Intents added for the bundle (not in the Python backend): crowd patterns
// (quietest day, weekday vs weekend, holidays), Lightning Lane prices and
// sell-out times, menu prices / menus, Drinking Around the World, ride facts
// (height, indoor, toddler, rain), special events and closures.
//
// Rules: answer only from bundle data, say the window/as-of date, link the
// page the data came from, and return _quality 0 (silent) when the bundle
// doesn't have what was asked. Opinion questions never reach here.

import { MAX_CLOSURES_AGE_MS } from '../core/config.js';
import type { AnswerEnv, Facts, Link } from './answer.js';
import { partialRatio } from './fuzz.js';
import { parkDisplayName, targetParks, type ParsedQuestion } from './parse.js';
import { hasPhrase, normalize } from './text.js';
import type {
  Core,
  Dest,
  MenuFile,
  Pattern,
  Restaurant,
  Ride,
} from './types.js';
import {
  fmtDay,
  fmtMoney,
  isoDay,
  longIso,
  monthAbbr,
  parseIsoDay,
  shortIso,
  weekday,
  WEEKDAY_NAMES,
  ymd,
  type Day,
} from './util.js';

export const EXTRA_INTENTS = new Set<string>([
  'crowd_pattern',
  'll_price',
  'll_sellout',
  'menu_price',
  'menu_lookup',
  'daw',
  'ride_height',
  'ride_indoor',
  'ride_toddler',
  'ride_rain',
  'special_events',
  'closures',
]);

export const EXTRA_LABELS: Record<string, string> = {
  crowd_pattern: 'Crowds by day',
  ll_price: 'Lightning Lane price',
  ll_sellout: 'Lightning Lane sell-outs',
  menu_price: 'Menu prices',
  menu_lookup: 'Menu',
  daw: 'Drinking Around the World',
  ride_height: 'Height',
  ride_indoor: 'Indoor rides',
  ride_toddler: 'Rides for little ones',
  ride_rain: 'Rain',
  special_events: 'Special events',
  closures: 'Closures',
};

const MAX_LIST = 10;
const WATER_PARK_WORDS = /\b(water ?parks?|typhoon lagoon|blizzard beach)\b/;
const CANT_RIDE = /\b(not|cant|can t|cannot|wont|won t|too (short|small|little)|unable|isnt|is not) (be able to )?(ride|tall|go on|do)\b|\b(not|cant|can t|cannot) ride\b|\btoo (short|small|little)\b/;

// ---------------------------------------------------------------- shared helpers

function destName(env: AnswerEnv, dest: Dest): string {
  return env.common.destinations[dest]?.name ?? dest;
}

function scopeName(env: AnswerEnv, pq: ParsedQuestion): string {
  return pq.parkSlug
    ? parkDisplayName(env.common, pq.destination, pq.parkSlug)
    : destName(env, pq.destination);
}

function sym(env: AnswerEnv, dest: Dest): string {
  return env.common.destinations[dest]?.currency_symbol ?? '$';
}

function joinList(xs: string[], max = MAX_LIST): string {
  if (xs.length <= max) return xs.join(', ');
  return `${xs.slice(0, max).join(', ')} (+${xs.length - max} more)`;
}

function dayShort(day: Day): string {
  const { m, d } = ymd(day);
  return `${(WEEKDAY_NAMES[weekday(day)] as string).slice(0, 3)} ${monthAbbr(m)} ${d}`;
}

/** "2026-09-28 1:40 PM" -> "Sep 28, 1:40 PM". */
function fmtChecked(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(s);
  return m ? `${shortIso(m[1] as string)}, ${m[2]}` : s;
}

/** "2026-09-28T13:48-04:00" -> "Sep 28, 1:48 PM". */
function fmtAsOf(iso: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? null;
  const h = Number(m[2]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${shortIso(m[1] as string)}, ${h12}:${m[3]} ${h < 12 ? 'AM' : 'PM'}`;
}

function tzLabel(dest: Dest): string {
  return dest === 'wdw' ? 'ET' : dest === 'dlr' ? 'PT' : 'park time';
}

function parkOk(pq: ParsedQuestion, park: string | null | undefined): boolean {
  if (pq.parks.length > 1) return !!park && pq.parks.includes(park);
  return !pq.parkSlug || park === pq.parkSlug;
}

function rideOf(core: Core, pq: ParsedQuestion): Ride | null {
  return pq.ride ? (core.rides[pq.ride.entityId] ?? null) : null;
}

function linkTo(title: string, url: string | null | undefined): Link | null {
  return url ? { title, url } : null;
}

function links(...xs: (Link | null)[]): Link[] {
  const out: Link[] = [];
  for (const l of xs)
    if (l && !out.some((o) => o.url === l.url) && out.length < 3) out.push(l);
  return out;
}

/** Real rides (with wait data) in the question's park(s). */
function tracked(core: Core, pq: ParsedQuestion): Ride[] {
  return Object.values(core.rides)
    .filter((r) => r.waits && parkOk(pq, r.park))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

// ---------------------------------------------------------------- crowd patterns

const HOLIDAY_GROUPS: [RegExp, RegExp][] = [
  [/\bgolden week\b/, /golden week/],
  [
    /\b(chinese|lunar) new year\b|\bspring festival\b/,
    /spring festival|lunar new year|chinese new year/,
  ],
  [/\bspring break\b|\beaster\b/, /spring break|easter/],
  [/\bsummer\b/, /summer/],
  [
    /\bwinter break\b|\bchristmas\b|(?<!(chinese|lunar) )\bnew years?\b/,
    /winter|christmas|(?<!lunar |chinese )new year/,
  ],
  [/\bthanksgiving\b/, /thanksgiving/],
  [/\bmid autumn\b/, /mid-autumn/],
  [/\bnational day\b/, /national day/],
  [/\bqingming\b/, /qingming/],
  [/\bdragon boat\b/, /dragon boat/],
  [/\bmay day\b|\blabou?r day\b/, /may day|labou?r day/],
  [/\bobon\b|\bsilver week\b/, /obon|silver week/],
];

function pct(n: number): string {
  return `${n > 0 ? '+' : ''}${n}%`;
}

function spanLabel(start: string, end: string): string {
  const s = parseIsoDay(start);
  const e = parseIsoDay(end);
  if (s === null || e === null) return `${start} to ${end}`;
  const ys = ymd(s).y;
  const ye = ymd(e).y;
  return ys === ye
    ? `${shortIso(start)}–${shortIso(end)}, ${ye}`
    : `${longIso(start)}–${longIso(end)}`;
}

function crowdPatternFacts(
  _env: AnswerEnv,
  core: Core,
  pq: ParsedQuestion
): Facts {
  const scope =
    pq.parkSlug && core.crowd_patterns[pq.parkSlug] ? pq.parkSlug : 'all';
  const pat: Pattern | undefined = core.crowd_patterns[scope];
  const facts: Facts = { type: 'crowd_pattern', sub: pq.sub, _quality: 0 };
  if (!pat) return facts;
  facts.scope = pat.scope;
  facts._links = links(
    linkTo(`${pat.scope} crowds by day of week`, pat.url),
    linkTo(
      'Best days to go',
      pq.parkSlug
        ? core.parks[pq.parkSlug]?.urls.best_days
        : core.urls.best_days
    ),
    linkTo('Crowd calendar', core.urls.crowd_calendar)
  );
  const prof = pat.profile;
  const profQ = prof ? (prof.days >= 60 ? 1.0 : prof.days >= 21 ? 0.85 : 0) : 0;
  const faq = (re: RegExp) => pat.faq.find((f) => re.test(f.q))?.a ?? null;

  if (pq.sub === 'dow') {
    if (!prof || !pat.headline) return facts;
    facts.text = pat.headline;
    const bw = /\bweekday\b/.test(pq.normalized) ? faq(/best weekday/i) : null;
    if (bw) facts.text = bw;
    facts._quality = profQ;
    return facts;
  }
  if (pq.sub === 'weekpart') {
    const satSun = /\bsaturday or sunday\b|\bsunday or saturday\b/.test(
      pq.normalized
    );
    const a = satSun
      ? faq(/saturday or sunday/i)
      : faq(/weekends or weekdays/i);
    const text =
      a ??
      (pat.verdict && prof
        ? `${pat.verdict} (average posted wait, last ${prof.window_days} days)`
        : null);
    if (!text || !prof) return facts;
    facts.text = text;
    facts._quality = profQ;
    return facts;
  }
  // holidays
  const groups = HOLIDAY_GROUPS.filter(([q]) => q.test(pq.normalized)).map(
    ([, n]) => n
  );
  if (!groups.length) {
    const a = faq(/holidays/i);
    if (a) {
      facts.text = a;
      facts._quality = profQ;
    }
    return facts;
  }
  const match = (name: string) =>
    groups.some((g) => g.test(name.toLowerCase()));
  const past = pat.holiday_impact
    .filter(
      (h) => match(h.name) && h.pct !== undefined && h.avg_wait !== undefined
    )
    .sort((a, b) => (a.start < b.start ? 1 : -1));
  const todayIso = isoDay(pq.today);
  const next = pat.upcoming_holidays
    .filter((h) => match(h.name) && h.end >= todayIso)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  const h = past[0];
  if (!h) return facts; // no measured holiday period: nothing data-backed to say
  facts.holiday = {
    name: h.name,
    when: spanLabel(h.start, h.end),
    avg_wait: h.avg_wait,
    baseline_wait: h.baseline_wait,
    pct: pct(h.pct as number),
    days_with_data: h.days_with_data,
  };
  const n = next[0];
  if (n)
    facts.next = {
      name: n.name,
      when: spanLabel(n.start, n.end),
      status: n.status ?? null,
    };
  const dwd = h.days_with_data ?? 0;
  facts._quality = dwd >= 5 ? 1.0 : dwd >= 3 ? 0.85 : 0.6;
  return facts;
}

function crowdPatternText(facts: Facts): string {
  if (facts.text) return facts.text;
  const h = facts.holiday;
  if (!h) return "I don't have wait data for that period.";
  let s =
    `${h.name} (${h.when}) at ${facts.scope}: average posted wait ${h.avg_wait} min vs ` +
    `${h.baseline_wait} min on nearby non-holiday days (${h.pct}), from our wait data.`;
  const n = facts.next;
  if (n) s += ` Next: ${n.name}, ${n.when}${n.status ? ` (${n.status})` : ''}.`;
  return s;
}

// ---------------------------------------------------------------- Lightning Lane

async function llPriceFacts(
  env: AnswerEnv,
  core: Core,
  pq: ParsedQuestion
): Promise<Facts> {
  const facts: Facts = { type: 'll_price', _quality: 0, rows: [] };
  const ll = await env.src.ll(pq.destination);
  if (!ll) return facts;
  const ride = rideOf(core, pq);
  const parks = ride?.park
    ? [ride.park]
    : targetParks(env.common, pq).slice(0, 4);
  const dates = pq.dateExplicit ? pq.dates.slice(0, 7) : [pq.today];
  const wantPremier = /\bpremier\b/.test(pq.normalized);
  const cs = sym(env, pq.destination);
  for (const d of dates) {
    for (const p of parks) {
      const e = ll.prices[p]?.[isoDay(d)];
      if (!e) continue;
      const row: Facts = {
        date: fmtDay(d),
        park: parkDisplayName(env.common, pq.destination, p),
      };
      if (ride && pq.ride) {
        const sp = e.single_pass.find((x) => x.id === pq.ride?.entityId);
        if (!sp || sp.price === null) continue;
        row.single_pass = {
          ride: sp.name,
          price: fmtMoney(cs, sp.price),
          available: sp.available,
          checked: fmtChecked(e.single_pass_checked ?? e.checked),
        };
      } else if (wantPremier) {
        if (e.premier === null) continue;
        row.premier = fmtMoney(cs, e.premier);
        row.checked = fmtChecked(e.checked);
      } else {
        if (e.multipass === null && e.multipass_status !== 'unavailable')
          continue;
        row.multipass = e.multipass === null ? null : fmtMoney(cs, e.multipass);
        row.status = e.multipass_status;
        row.checked = fmtChecked(e.checked);
      }
      facts.rows.push(row);
    }
  }
  facts.tz = ll.sellout?.tz_label ?? tzLabel(pq.destination);
  facts._links = links(
    linkTo('Lightning Lane prices by date', ll.urls.pricing),
    ride
      ? linkTo(`${ride.name} Lightning Lane`, ride.urls.lightning_lane)
      : null,
    linkTo('Lightning Lane price by month', ll.urls.price_by_month)
  );
  facts._quality = facts.rows.length ? 1.0 : 0;
  return facts;
}

function llPriceText(facts: Facts): string {
  const rows: Facts[] = facts.rows;
  const tz = facts.tz;
  const r0 = rows[0] as Facts;
  if (r0.single_pass) {
    const bits = rows.map(
      (r) =>
        `${r.date}: ${r.single_pass.price}${r.single_pass.available ? '' : ' (not available at the last check)'}`
    );
    return (
      `${r0.single_pass.ride} Lightning Lane Single Pass, per person — ${bits.join('; ')}. ` +
      `Last checked ${r0.single_pass.checked} ${tz}; prices change with demand.`
    );
  }
  if (r0.premier) {
    const bits = rows.map((r) => `${r.park} ${r.date}: ${r.premier}`);
    return `Lightning Lane Premier Pass, per person — ${bits.join('; ')}. Last checked ${r0.checked} ${tz}.`;
  }
  const bits = rows.map((r) =>
    r.multipass === null || r.status === 'unavailable'
      ? `${r.park} ${r.date}: not on sale at the last check`
      : `${r.park} ${r.date}: ${r.multipass}`
  );
  return (
    `Lightning Lane Multi Pass, per person per day — ${bits.slice(0, 8).join('; ')}. ` +
    `Last checked ${r0.checked} ${tz}; prices change with demand.`
  );
}

async function llSelloutFacts(
  env: AnswerEnv,
  core: Core,
  pq: ParsedQuestion
): Promise<Facts> {
  const facts: Facts = { type: 'll_sellout', _quality: 0 };
  const ll = await env.src.ll(pq.destination);
  const so = ll?.sellout;
  if (!ll || !so) return facts;
  facts.window = spanLabel(so.first_date, so.last_date);
  facts.tracked_days = so.tracked_days;
  facts.tz = so.tz_label;
  const day =
    pq.dateExplicit && pq.dates.length === 1 ? (pq.dates[0] as Day) : null;
  const dowName = day !== null ? WEEKDAY_NAMES[weekday(day)] : null;
  const ride = rideOf(core, pq);
  let rec: Facts;
  if (pq.ride) {
    const r = so.rides.find((x) => x.id === pq.ride?.entityId);
    if (!r) return facts;
    rec = { what: `${r.name} Single Pass`, ...r };
  } else if (/\bmulti ?pass\b|\bllmp\b/.test(pq.normalized) && pq.parkSlug) {
    const m = so.multipass.find((x) => x.park === pq.parkSlug);
    if (!m) return facts;
    rec = { what: `Multi Pass for ${m.park_name}`, ...m };
  } else {
    return facts;
  }
  facts.what = rec.what;
  facts.offered_days = rec.offered_days;
  facts.gone_days = rec.gone_days;
  facts.gone_pct = rec.gone_pct;
  facts.sellout_time = rec.sellout_time;
  if (dowName) {
    const b = (rec.by_dow ?? []).find((x: any) => x.day === dowName);
    if (b && b.offered_days) facts.by_dow = b;
  }
  const st = rec.sellout_time;
  facts._quality = st
    ? st.days >= 10
      ? 1.0
      : st.days >= 5
        ? 0.85
        : 0.6
    : rec.offered_days >= 5
      ? 0.85
      : 0;
  facts._links = links(
    linkTo('Lightning Lane sell-out times', ll.urls.sellout),
    ride
      ? linkTo(`${ride.name} Lightning Lane`, ride.urls.lightning_lane)
      : null,
    linkTo('Should I buy Lightning Lane?', ll.urls.should_i_buy)
  );
  return facts;
}

function llSelloutText(facts: Facts): string {
  const tz = facts.tz;
  let s: string;
  if (!facts.gone_days) {
    s = `${facts.what} didn't sell out on any of the ${facts.offered_days} days it was on sale (tracked ${facts.window}).`;
  } else {
    s =
      `${facts.what} sold out on ${facts.gone_pct}% of the days it was on sale ` +
      `(${facts.gone_days} of ${facts.offered_days} days, tracked ${facts.window}).`;
    const st = facts.sellout_time;
    if (st)
      s += ` When it sold out, it was usually gone by about ${st.median} ${tz} (earliest ${st.earliest}, latest ${st.latest}).`;
  }
  const b = facts.by_dow;
  if (b) {
    s += ` On ${b.day}s: gone on ${b.gone_pct}% of ${b.offered_days} days${b.median ? `, typically by ${b.median} ${tz}` : ''}.`;
  }
  return s;
}

// ---------------------------------------------------------------- menus

type MenuHit = {
  name: string;
  price: number | null;
  restaurant: string;
  url: string;
  park: string | null;
};

async function allMenus(env: AnswerEnv, dest: Dest): Promise<MenuFile[]> {
  const n = await env.src.menuParts(dest);
  const out: MenuFile[] = [];
  for (let i = 1; i <= n; i++) {
    const m = await env.src.menus(dest, i);
    if (m) out.push(m);
  }
  return out;
}

const GENERIC_TAIL =
  / (restaurant and lounge|restaurant|dining room|cafe|lounge)$/;

/** Name forms of a restaurant: bundle variants plus the name without a generic "Restaurant"/"Cafe" tail. */
function restaurantForms(r: Restaurant): string[] {
  const out = new Set<string>([r.norm, ...r.variants]);
  for (const v of Array.from(out)) {
    const t = v.replace(GENERIC_TAIL, '');
    if (t !== v && t.length >= 6) out.add(t);
  }
  return Array.from(out);
}

/**
 * Restaurant named in the question: an exact phrase first (longest wins),
 * then a strict fuzzy partial_ratio. Returns [id, row, score].
 */
function matchRestaurant(
  env: AnswerEnv,
  core: Core,
  pq: ParsedQuestion
): [string, Restaurant, number] | null {
  const norm = pq.normalized;
  let best: [string, Restaurant, number] | null = null;
  let bestLen = 0;
  for (const [id, r] of Object.entries(core.restaurants)) {
    for (const v of restaurantForms(r)) {
      if (v.length >= 4 && v.length > bestLen && hasPhrase(norm, v)) {
        best = [id, r, 1.0];
        bestLen = v.length;
      }
    }
  }
  if (best) return best;
  let bestScore = 0;
  for (const [id, r] of Object.entries(core.restaurants)) {
    for (const v of restaurantForms(r)) {
      if (v.length < 12 || v.length > norm.length) continue;
      const sc = partialRatio(v, norm);
      if (sc > bestScore || (sc === bestScore && v.length > bestLen)) {
        best = [id, r, sc / 100];
        bestScore = sc;
        bestLen = v.length;
      }
    }
  }
  // Restaurant names are short and generic ("Food Studio"), so fuzzy needs a
  // stricter bar than rides: 95 and >= 12 characters.
  return best && bestScore >= Math.max(95, env.common.fuzzy_threshold)
    ? best
    : null;
}

const ITEM_PATTERNS = [
  /how much (?:is|are|does|do|was|were|for|would|will)\s+(?:it cost for\s+)?(?:an?|the|one|1|each)?\s*(.+?)(?:\s+(?:cost|costs|be|run|go for|usually cost))?(?:\s+(?:at|in|from|on|inside|near)\s+.+)?\s*[?.!]*$/,
  /(?:price|prices|cost) (?:of|for) (?:an?|the)?\s*(.+?)(?:\s+(?:at|in|from|on)\s+.+)?\s*[?.!]*$/,
  /^(.+?) (?:price|prices|cost)\b/,
];

function itemPhrase(textLower: string): string | null {
  const t = textLower.replace(/[“”"]/g, '').trim();
  for (const re of ITEM_PATTERNS) {
    const m = re.exec(t);
    if (m && m[1]) {
      const n = normalize(m[1])
        .replace(/^(an?|the|one|each)\s+/, '')
        .replace(/\s+(these days|now|right now|today|nowadays|currently)$/, '');
      if (n.length >= 3) return n;
    }
  }
  return null;
}

function singular(s: string): string {
  return s.replace(/(\w{3,})s\b/g, '$1');
}

async function menuPriceFacts(
  env: AnswerEnv,
  core: Core,
  pq: ParsedQuestion
): Promise<Facts> {
  const facts: Facts = { type: 'menu_price', _quality: 0 };
  let item = itemPhrase(pq.textLower);
  const rest = matchRestaurant(env, core, pq);
  if (rest) pq.matchScore = rest[2];
  if (item && rest) {
    for (const v of restaurantForms(rest[1]))
      item = item.replace(new RegExp(`\\b${v}\\b`), '').trim();
  }
  if (!item || item.length < 3) return facts;
  const want = singular(item).split(' ').filter(Boolean);
  const hits: MenuHit[] = [];
  let checked: string | null = null;
  let fresh = 30;
  for (const mf of await allMenus(env, pq.destination)) {
    fresh = mf.fresh_days;
    for (const [id, r] of Object.entries(mf.restaurants)) {
      if (rest && id !== rest[0]) continue;
      if (!rest && !parkOk(pq, r.park)) continue;
      for (const secs of Object.values(r.periods)) {
        for (const items of Object.values(secs)) {
          for (const [name, price] of items) {
            if (price === null) continue;
            const nm = ` ${singular(normalize(name))} `;
            if (!want.every((w) => nm.includes(` ${w} `))) continue;
            // "Beer-battered Onion Rings" is not a beer: the head word can't be a hyphenated modifier.
            const head = want[want.length - 1] as string;
            if (new RegExp(`\\b${head}s?-`, 'i').test(name)) continue;
            if (
              hits.some(
                (h) =>
                  h.name === name &&
                  h.restaurant === r.name &&
                  h.price === price
              )
            )
              continue;
            hits.push({
              name,
              price,
              restaurant: r.name,
              url: r.url,
              park: r.park,
            });
            if (r.checked && (!checked || r.checked > checked))
              checked = r.checked;
          }
        }
      }
    }
  }
  if (!hits.length) return facts;
  const cs = sym(env, pq.destination);
  hits.sort(
    (a, b) =>
      (a.price as number) - (b.price as number) ||
      a.name.localeCompare(b.name, 'en')
  );
  const lo = hits[0] as MenuHit;
  const hi = hits[hits.length - 1] as MenuHit;
  facts.item = item;
  facts.where = rest ? rest[1].name : scopeName(env, pq);
  facts.count = hits.length;
  facts.locations = new Set(hits.map((h) => h.restaurant)).size;
  facts.low = {
    name: lo.name,
    price: fmtMoney(cs, lo.price as number),
    restaurant: lo.restaurant,
  };
  facts.high = {
    name: hi.name,
    price: fmtMoney(cs, hi.price as number),
    restaurant: hi.restaurant,
  };
  facts.fresh_days = fresh;
  facts.checked = checked ? shortIso(checked) : null;
  facts._quality = 1.0;
  facts._links = links(
    linkTo(`${lo.restaurant} menu`, lo.url),
    rest
      ? null
      : linkTo(
          `${destName(env, pq.destination)} food prices`,
          core.urls.food_prices
        ),
    lo.url !== hi.url ? linkTo(`${hi.restaurant} menu`, hi.url) : null
  );
  return facts;
}

function menuPriceText(facts: Facts): string {
  const seen = `Disney menus seen in the last ${facts.fresh_days} days${facts.checked ? `, newest ${facts.checked}` : ''}`;
  if (facts.count === 1) {
    return `${facts.low.name} at ${facts.low.restaurant}: ${facts.low.price} (${seen}).`;
  }
  const head = `Menu prices for "${facts.item}" at ${facts.where} (${seen}): ${facts.count} items at ${facts.locations} location${facts.locations === 1 ? '' : 's'}`;
  if (facts.low.price === facts.high.price) {
    return `${head}, all ${facts.low.price} (e.g. ${facts.low.name}, ${facts.low.restaurant}).`;
  }
  return (
    `${head}, from ${facts.low.price} (${facts.low.name}, ${facts.low.restaurant}) ` +
    `to ${facts.high.price} (${facts.high.name}, ${facts.high.restaurant}).`
  );
}

const MEALS = [
  'breakfast',
  'brunch',
  'lunch',
  'dinner',
  'snacks',
  'dessert',
  'drinks',
  'all day',
];

async function menuLookupFacts(
  env: AnswerEnv,
  core: Core,
  pq: ParsedQuestion
): Promise<Facts> {
  const facts: Facts = { type: 'menu_lookup', _quality: 0 };
  const rest = matchRestaurant(env, core, pq);
  if (!rest || !rest[1].menu_part) return facts;
  pq.matchScore = rest[2];
  const mf = await env.src.menus(pq.destination, rest[1].menu_part);
  const menu = mf?.restaurants[rest[0]];
  if (!menu) return facts;
  const cs = sym(env, pq.destination);
  const periods = Object.keys(menu.periods);
  const asked = MEALS.filter((m) => hasPhrase(pq.normalized, m));
  let pick = periods.filter((p) =>
    asked.some((a) => normalize(p).includes(a.replace(/s$/, '')))
  );
  if (asked.length && !pick.length) {
    facts.restaurant = menu.name;
    facts.periods = periods;
    facts.missing = asked[0];
    facts.checked = menu.checked ? shortIso(menu.checked) : null;
    facts._quality = 0.85;
    facts._links = links(linkTo(`${menu.name} menu`, menu.url));
    return facts;
  }
  if (!pick.length) pick = periods.slice(0, 1);
  const sections: Facts[] = [];
  let count = 0;
  for (const p of pick.slice(0, 1)) {
    // Regular sections before the allergy-friendly duplicates.
    const secsOrdered = Object.entries(menu.periods[p] ?? {}).sort(
      (x, y) => Number(/allergy/i.test(x[0])) - Number(/allergy/i.test(y[0]))
    );
    for (const [sec, items] of secsOrdered) {
      if (count >= 14) break;
      const shown = items.slice(0, Math.max(0, 14 - count));
      count += shown.length;
      sections.push({
        section: sec,
        items: shown.map(([n, pr]) =>
          pr === null ? n : `${n} ${fmtMoney(cs, pr)}`
        ),
        more: items.length - shown.length,
      });
    }
  }
  facts.restaurant = menu.name;
  facts.period = pick[0];
  facts.periods = periods;
  facts.sections = sections;
  facts.checked = menu.checked ? shortIso(menu.checked) : null;
  facts._quality = asked.length || periods.length === 1 ? 1.0 : 0.85;
  facts._links = links(
    linkTo(`${menu.name} menu`, menu.url),
    linkTo(menu.name, rest[1].url)
  );
  return facts;
}

function menuLookupText(facts: Facts): string {
  const asOf = facts.checked
    ? ` (Disney's menu, last seen ${facts.checked})`
    : '';
  if (facts.missing) {
    return `${facts.restaurant} doesn't list a ${facts.missing} menu right now${asOf}; its menus: ${facts.periods.join(', ')}.`;
  }
  const secs = (facts.sections as Facts[])
    .map(
      (s) =>
        `${s.section}: ${s.items.join('; ')}${s.more > 0 ? ` (+${s.more} more)` : ''}`
    )
    .join('. ');
  const other = (facts.periods as string[]).filter((p) => p !== facts.period);
  return (
    `${facts.restaurant}, ${facts.period}${asOf} — ${secs}.` +
    (other.length ? ` Also on the menu page: ${other.join(', ')}.` : '')
  );
}

async function dawFacts(env: AnswerEnv, pq: ParsedQuestion): Promise<Facts> {
  const facts: Facts = { type: 'daw', _quality: 0 };
  const daw = await env.src.daw('wdw');
  if (!daw) return facts;
  const pav = daw.pavilions.find(
    (p) =>
      hasPhrase(pq.normalized, normalize(p.name)) ||
      hasPhrase(pq.normalized, normalize(p.slug))
  );
  facts.checked = daw.total.checked ? longIso(daw.total.checked) : null;
  facts._links = links(
    linkTo('Drinking Around the World', daw.url),
    pav ? linkTo(`${pav.name} pavilion drinks`, pav.url) : null
  );
  const priceOf = (p: (typeof daw.pavilions)[number]) => {
    const sig = p.signature;
    if (!sig) return null;
    if (sig.price?.display)
      return sig.price.source === 'estimate'
        ? `about ${sig.price.display}`
        : sig.price.display;
    return sig.price_estimate ? `about ${sig.price_estimate}` : null;
  };
  if (pav) {
    if (!pav.signature) return facts;
    facts.pavilion = {
      name: pav.name,
      drink: pav.signature.name,
      price: priceOf(pav),
      drinks: pav.drinks_count,
      walk_up: pav.walk_up_count,
    };
    facts._quality = 1.0;
    return facts;
  }
  if (!daw.total.display) return facts;
  facts.total = daw.total.display;
  facts.estimate = daw.total.estimate_count > 0;
  facts.count = daw.pavilions.filter((p) => p.signature).length;
  facts.list = daw.pavilions
    .filter((p) => p.signature)
    .map(
      (p) =>
        `${p.name}: ${p.signature?.name}${priceOf(p) ? ` ${priceOf(p)}` : ''}`
    );
  facts._quality = 1.0;
  return facts;
}

function dawText(facts: Facts): string {
  const asOf = facts.checked ? ` (menu prices as of ${facts.checked})` : '';
  const p = facts.pavilion;
  if (p) {
    return (
      `Our Drinking Around the World pick for ${p.name} is the ${p.drink}${p.price ? ` (${p.price})` : ''}${asOf}. ` +
      `We track ${p.drinks} drinks there, ${p.walk_up} of them at walk-up spots.`
    );
  }
  return (
    `Drinking Around the World at EPCOT with one signature drink in each of the ${facts.count} pavilions costs ` +
    `${facts.estimate ? 'about ' : ''}${facts.total} at menu prices${asOf}: ${facts.list.join('; ')}.`
  );
}

// ---------------------------------------------------------------- ride facts

function heightFacts(env: AnswerEnv, core: Core, pq: ParsedQuestion): Facts {
  const facts: Facts = { type: 'ride_height', _quality: 0 };
  const h = pq.heightIn;
  facts._links = links(
    linkTo(
      `${destName(env, pq.destination)} height requirements`,
      core.urls.height_requirements
    ),
    pq.ride
      ? linkTo(pq.ride.name, core.rides[pq.ride.entityId]?.urls.page)
      : null
  );
  const ride = rideOf(core, pq);
  if (ride && pq.ride) {
    facts.ride = ride.name;
    if (ride.kids_only && ride.height_max_in) {
      facts.kids_only_max = `${ride.height_max_in} inches`;
      if (h !== null) facts.fits = h <= ride.height_max_in;
      facts._quality = 1.0;
    } else if (ride.height_min_in) {
      facts.min = `${ride.height_min_in}-inch`;
      if (h !== null) {
        facts.child = `${h}-inch`;
        facts.ok = h >= ride.height_min_in;
        if (!facts.ok) {
          const d = Math.round((ride.height_min_in - h) * 10) / 10;
          facts.short_by = `${d} inch${d === 1 ? '' : 'es'}`;
        }
      }
      facts._quality = 1.0;
    } else if (ride.no_min_height) {
      facts.no_min = true;
      facts._quality = 0.85;
    }
    return facts;
  }
  // 2026-10-24 ("What rides can my 44inch child NOT ride?"): theme parks only unless the
  // question names a water park (their slides have no park and crowded the list), grouped
  // by park, and a "can't ride" question leads with what's too tall for the child.
  const water = WATER_PARK_WORDS.test(pq.normalized);
  const rides = Object.values(core.rides).filter(
    (r) => r.height_min_in && (r.park ? parkOk(pq, r.park) : water && !pq.parkSlug)
  );
  if (rides.length < 3) return facts;
  rides.sort(
    (a, b) =>
      (b.height_min_in as number) - (a.height_min_in as number) ||
      a.name.localeCompare(b.name, 'en')
  );
  const fmt = (r: Ride) => `${r.name} (${r.height_min_in} in)`;
  const parkOrder = (rs: Ride[]) => {
    const order: string[] = [];
    for (const r of rs) if (!order.includes(r.park ?? '')) order.push(r.park ?? '');
    return order;
  };
  const grouped = (rs: Ride[], max: number): string | null => {
    if (!rs.length) return null;
    const parks = parkOrder(rs);
    if (parks.length === 1) return joinList(rs.map(fmt), max);
    return parks
      .map((p) => {
        const name = p ? parkDisplayName(env.common, pq.destination, p) : 'Water parks';
        return `${name}: ${joinList(rs.filter((r) => (r.park ?? '') === p).map(fmt), 4)}`;
      })
      .join('; ');
  };
  facts.where = scopeName(env, pq);
  facts.untracked = tracked(core, pq).filter(
    (r) => !r.height_min_in && !r.kids_only
  ).length;
  if (h !== null) {
    facts.child = `${h}-inch`;
    const can = rides.filter((r) => (r.height_min_in as number) <= h);
    const cannot = rides.filter((r) => (r.height_min_in as number) > h);
    facts.can = grouped(can, MAX_LIST);
    facts.can_count = can.length;
    facts.cannot = grouped(cannot, MAX_LIST);
    facts.negative = CANT_RIDE.test(pq.normalized);
  } else {
    facts.all = grouped(rides, 15);
  }
  facts._quality = 1.0;
  return facts;
}

function heightText(facts: Facts): string {
  if (facts.ride) {
    if (facts.kids_only_max) {
      return `${facts.ride} is a kids-only area (maximum height ${facts.kids_only_max}).`;
    }
    if (facts.no_min)
      return `${facts.ride} has no posted minimum height in our data.`;
    let s = `${facts.ride} has a ${facts.min} minimum height`;
    if (facts.child) {
      s += facts.ok
        ? `, so a ${facts.child} child meets it.`
        : `, so a ${facts.child} child is ${facts.short_by} too short.`;
    } else s += '.';
    return s;
  }
  const tail =
    facts.untracked > 0
      ? ` The other ${facts.untracked} rides we track at ${facts.where} have no posted minimum in our data.`
      : '';
  if (facts.child && facts.negative) {
    if (!facts.cannot)
      return `A ${facts.child} child meets every posted minimum height at ${facts.where}.${tail}`;
    return (
      `At ${facts.where}, a ${facts.child} child is too short for ${facts.cannot}. ` +
      `They meet the posted minimum for the other ${facts.can_count} rides that have one.${tail}`
    );
  }
  if (facts.child) {
    const can = facts.can
      ? `can ride ${facts.can}`
      : 'is under every posted minimum';
    const cannot = facts.cannot ? `; too short for ${facts.cannot}` : '';
    return `Rides with a posted minimum height at ${facts.where}: a ${facts.child} child ${can}${cannot}.${tail}`;
  }
  return `Posted minimum heights at ${facts.where}: ${facts.all}.${tail}`;
}

function toddlerFacts(env: AnswerEnv, core: Core, pq: ParsedQuestion): Facts {
  const rides = tracked(core, pq).filter(
    (r) => r.no_min_height && !r.height_min_in && !r.kids_only
  );
  const facts: Facts = { type: 'ride_toddler', _quality: 0 };
  if (rides.length < 3) return facts;
  facts.where = scopeName(env, pq);
  facts.count = rides.length;
  facts.rides = joinList(
    rides.map((r) => r.name),
    12
  );
  facts._quality = 0.85; // height data is sparse outside the headliners
  facts._links = links(
    linkTo(
      `${destName(env, pq.destination)} height requirements`,
      core.urls.height_requirements
    )
  );
  return facts;
}

function toddlerText(facts: Facts): string {
  return `${facts.count} rides we track at ${facts.where} have no posted minimum height in our data: ${facts.rides}.`;
}

function indoorFacts(env: AnswerEnv, core: Core, pq: ParsedQuestion): Facts {
  const facts: Facts = { type: 'ride_indoor', _quality: 0 };
  facts._links = links(
    linkTo(
      `${destName(env, pq.destination)} indoor rides`,
      core.urls.indoor_rides
    )
  );
  const ride = rideOf(core, pq);
  if (ride) {
    if (ride.indoor === null) return facts;
    facts.ride = ride.name;
    facts.indoor = ride.indoor;
    facts._quality = 1.0;
    return facts;
  }
  const rides = tracked(core, pq).filter((r) => r.indoor === true);
  if (rides.length < 3) return facts;
  facts.where = scopeName(env, pq);
  facts.rides = joinList(
    rides.map((r) => r.name),
    15
  );
  facts._quality = 1.0;
  return facts;
}

function indoorText(facts: Facts): string {
  if (facts.ride)
    return facts.indoor
      ? `${facts.ride} is an indoor attraction.`
      : `${facts.ride} is outdoors.`;
  return `Indoor rides at ${facts.where} (from our ride data): ${facts.rides}.`;
}

function rainFacts(env: AnswerEnv, core: Core, pq: ParsedQuestion): Facts {
  const facts: Facts = {
    type: 'ride_rain',
    _quality: 0,
    unit: 'breakdowns per 100 open hours',
    small_note: 'under 100 rainy hours',
  };
  const rain = core.rain;
  if (!rain) return facts;
  facts._links = links(
    linkTo(
      `${destName(env, pq.destination)} rain closures`,
      core.urls.rain_closures ?? rain.url
    ),
    pq.ride
      ? linkTo(pq.ride.name, core.rides[pq.ride.entityId]?.urls.page)
      : null
  );
  const ride = rideOf(core, pq);
  if (ride) {
    const rp = ride.park ? rain.parks[ride.park] : undefined;
    if (!ride.rain || !rp || ride.rain.ratio === null) return facts;
    facts.ride = ride.name;
    facts.sensitive = ride.rain.sensitive;
    facts.ratio = `${ride.rain.ratio}x`;
    facts.wet = ride.rain.wet_rate_per_100h;
    facts.dry = ride.rain.dry_rate_per_100h;
    facts.window = `${shortIso(rp.window_start)}–${longIso(rp.window_end)}`;
    facts.small = rp.small_sample;
    facts._quality = rp.small_sample ? 0.85 : 1.0;
    return facts;
  }
  const parks = pq.parkSlug
    ? [pq.parkSlug]
    : pq.parks.length
      ? pq.parks
      : Object.keys(rain.parks);
  const rows: Facts[] = [];
  for (const p of parks.slice(0, 4)) {
    const rp = rain.parks[p];
    if (!rp) continue;
    rows.push({
      park: parkDisplayName(env.common, pq.destination, p),
      window: `${shortIso(rp.window_start)}–${longIso(rp.window_end)}`,
      wet_hours: rp.wet_hours,
      small: rp.small_sample,
      rides: rp.sensitive
        .slice(0, pq.parkSlug ? 8 : 4)
        .map((s) => `${s.name}${s.ratio ? ` (${s.ratio}x)` : ''}`),
    });
  }
  if (!rows.length) return facts;
  facts.rows = rows;
  facts._quality = rows.some((r) => r.small) ? 0.85 : 1.0;
  return facts;
}

function rainText(facts: Facts): string {
  if (facts.ride) {
    const lead = facts.sensitive
      ? `${facts.ride} is rain-sensitive: it broke down ${facts.ratio} as often in rainy hours`
      : `${facts.ride} isn't flagged as rain-sensitive: it broke down ${facts.ratio} as often in rainy hours`;
    return (
      `${lead} (${facts.wet} vs ${facts.dry} ${facts.unit}, ${facts.window}` +
      `${facts.small ? ', small sample' : ''}).`
    );
  }
  const bits = (facts.rows as Facts[]).map((r) =>
    r.rides.length
      ? `${r.park}: ${r.rides.join(', ')}`
      : `${r.park}: no ride stood out`
  );
  const r0 = facts.rows[0] as Facts;
  const small = (facts.rows as Facts[]).some((r) => r.small)
    ? ` Some parks have a small sample (${facts.small_note}).`
    : '';
  return (
    `Rides that break down at least twice as often when it rains (vs. their dry-weather rate), from our wait data ` +
    `${r0.window} — ${bits.join('; ')}.${small}`
  );
}

// ---------------------------------------------------------------- events / closures

async function eventsFacts(
  env: AnswerEnv,
  core: Core,
  pq: ParsedQuestion
): Promise<Facts> {
  const facts: Facts = { type: 'special_events', _quality: 0 };
  const ev = await env.src.events(pq.destination);
  if (!ev) return facts;
  // The schedule covers 14 days from the data's own date; with an older
  // snapshot the default window starts today, never in the past.
  const dataFirst = parseIsoDay(ev.local_date) ?? pq.today;
  const last = dataFirst + 13;
  const first = Math.max(dataFirst, pq.today);
  const asked = pq.dateExplicit
    ? pq.dates
    : Array.from({ length: 14 }, (_, i) => first + i);
  const days = asked.filter((d) => d >= first && d <= last);
  if (!days.length) return facts;
  const want = new Set(days.map(isoDay));
  const groups = new Map<string, Facts>();
  const seasonal: Facts[] = [];
  const nameQ = normalize(pq.normalized);
  for (const e of ev.special_events) {
    if (!parkOk(pq, e.park)) continue;
    if (e.kind === 'seasonal') {
      if (days.some((d) => isoDay(d) >= e.start && isoDay(d) <= e.end)) {
        seasonal.push({
          name: e.name,
          park: parkDisplayName(env.common, pq.destination, e.park),
          when: `${shortIso(e.start)}–${shortIso(e.end)}`,
        });
      }
      continue;
    }
    for (const d of e.dates) {
      if (!want.has(d.date)) continue;
      const name = e.likely_event ?? e.name;
      const key = `${e.park}|${name}|${d.open}|${d.close}`;
      const g =
        groups.get(key) ??
        ({
          name,
          disney_label:
            e.likely_event && e.likely_event !== e.name ? e.name : null,
          park: parkDisplayName(env.common, pq.destination, e.park),
          time: `${d.open}–${d.close}`,
          dates: [] as string[],
        } as Facts);
      g.dates.push(dayShort(parseIsoDay(d.date) as Day));
      groups.set(key, g);
    }
  }
  let items = Array.from(groups.values());
  let seas = seasonal.filter((x) => !items.some((g) => g.name === x.name));
  // "Is there a Halloween party on Oct 2?" -> only matching events when a name was given
  // (park names and generic words don't count as naming an event).
  const generic = new Set([
    'special',
    'event',
    'events',
    'ticketed',
    'party',
    'parties',
    'night',
    'nights',
    'disney',
    'disneys',
    'mickeys',
    'international',
  ]);
  for (const p of env.common.destinations[pq.destination]?.parks ?? []) {
    for (const w of normalize(p.name).split(' ')) generic.add(w);
  }
  const isNamed = (n: string) =>
    normalize(n)
      .split(' ')
      .some((w) => w.length > 4 && !generic.has(w) && hasPhrase(nameQ, w));
  if (items.some((g) => isNamed(g.name)) || seas.some((x) => isNamed(x.name))) {
    items = items.filter((g) => isNamed(g.name));
    seas = seas.filter((x) => isNamed(x.name));
  }
  for (const g of items) g.dates = joinList(g.dates, 6);
  facts.items = items;
  facts.seasonal = seas;
  facts.one_park = !!pq.parkSlug;
  facts.where = scopeName(env, pq);
  facts.when =
    days.length === 1
      ? fmtDay(days[0] as Day)
      : `${dayShort(days[0] as Day)}–${dayShort(days[days.length - 1] as Day)}`;
  facts.as_of = shortIso(ev.local_date ?? isoDay(pq.today));
  facts._quality = items.length || seasonal.length ? 1.0 : 0.85;
  facts._links = links(
    linkTo(
      `${destName(env, pq.destination)} special events`,
      ev.urls.special_events
    ),
    pq.parkSlug
      ? linkTo(
          `${scopeName(env, pq)} park hours`,
          core.parks[pq.parkSlug]?.urls.hours
        )
      : null
  );
  return facts;
}

function eventsText(facts: Facts): string {
  const items: Facts[] = facts.items;
  const seasonal: Facts[] = facts.seasonal;
  if (!items.length && !seasonal.length) {
    return `No special events are listed for ${facts.where} on ${facts.when} in Disney's published schedule as of ${facts.as_of}.`;
  }
  const bits = items
    .slice(0, 6)
    .map(
      (g) =>
        `${facts.one_park ? '' : `${g.park}: `}${g.name}${g.disney_label ? ` (Disney lists it as "${g.disney_label}")` : ''}, ${g.time} on ${g.dates}`
    );
  const seas = seasonal
    .slice(0, 4)
    .map(
      (s) => `${s.name}${facts.one_park ? '' : ` at ${s.park}`} (${s.when})`
    );
  let s = `Special events for ${facts.where}, ${facts.when} (Disney's schedule as of ${facts.as_of})`;
  if (bits.length) s += ` — ${bits.join('; ')}.`;
  else s += '.';
  if (seas.length) s += ` Seasonal: ${seas.join('; ')}.`;
  return s;
}

const CLOSURE_LIST_WORDS =
  /\brefurb\w*|\bclosures?\b|\bwhat (is |s )?closed\b|\banything closed\b|\b(rides?|attractions?) (are |is )?closed\b|\bclosed (rides?|attractions?)\b|\bnot operating\b|\bdown for\b/;

async function closuresFacts(
  env: AnswerEnv,
  core: Core,
  pq: ParsedQuestion
): Promise<Facts> {
  const facts: Facts = { type: 'closures', _quality: 0 };
  const ev = await env.src.events(pq.destination);
  if (!ev) return facts;
  // "Operating in the last ~24 hours" is only true of recent data: stay
  // silent on closures when the data is older than 2 days.
  const built = Date.parse(ev.generated_at);
  if (!(env.now.getTime() - built <= MAX_CLOSURES_AGE_MS)) return facts;
  const cl = ev.closures;
  facts.as_of = `${fmtAsOf(cl.as_of)} ${tzLabel(pq.destination)}`;
  facts.recent = 'the last ~24 hours';
  facts._links = links(
    linkTo(
      `${destName(env, pq.destination)} closures`,
      cl.url ?? ev.urls.closures
    ),
    pq.parkSlug
      ? linkTo(
          `${scopeName(env, pq)} closures`,
          core.parks[pq.parkSlug]?.urls.closures
        )
      : null
  );
  if (pq.ride) {
    const id = pq.ride.entityId;
    facts.ride = pq.ride.name;
    facts.status = cl.refurbishment.some((x) => x.id === id)
      ? 'refurb'
      : cl.not_operating_24h.some((x) => x.id === id)
        ? 'down'
        : 'open';
    facts._quality = facts.status === 'open' ? 0.85 : 1.0;
    return facts;
  }
  if (!CLOSURE_LIST_WORDS.test(pq.normalized)) return facts;
  const pn = (x: { park: string | null }) =>
    x.park ? parkDisplayName(env.common, pq.destination, x.park) : '';
  const fmt = (x: { name: string; park: string | null }) =>
    pq.parkSlug || !x.park ? x.name : `${x.name} (${pn(x)})`;
  facts.where = scopeName(env, pq);
  const refurb = cl.refurbishment.filter((x) => parkOk(pq, x.park)).map(fmt);
  const down = cl.not_operating_24h.filter((x) => parkOk(pq, x.park)).map(fmt);
  facts.refurb = refurb.length ? joinList(refurb) : null;
  facts.down = down.length ? joinList(down) : null;
  facts._quality = refurb.length || down.length ? 1.0 : 0.85;
  return facts;
}

function closuresText(facts: Facts): string {
  if (facts.ride) {
    if (facts.status === 'refurb')
      return `${facts.ride} is listed as closed for refurbishment (as of ${facts.as_of}).`;
    if (facts.status === 'down') {
      return `${facts.ride} hasn't posted an operating status in ${facts.recent} (as of ${facts.as_of}); it may be temporarily closed.`;
    }
    return `${facts.ride} isn't on our refurbishment list and was operating in ${facts.recent} (as of ${facts.as_of}). Live status can change during the day.`;
  }
  if (!facts.refurb && !facts.down) {
    return `Nothing at ${facts.where} is listed as closed for refurbishment or down for ${facts.recent} (as of ${facts.as_of}).`;
  }
  const bits: string[] = [];
  if (facts.refurb) bits.push(`closed for refurbishment: ${facts.refurb}`);
  if (facts.down)
    bits.push(`no operating status in ${facts.recent}: ${facts.down}`);
  return `${facts.where} as of ${facts.as_of} — ${bits.join('; ')}. Closures can change during the day.`;
}

// ---------------------------------------------------------------- dispatch

export async function extraFacts(
  env: AnswerEnv,
  core: Core,
  pq: ParsedQuestion
): Promise<Facts> {
  switch (pq.intent) {
    case 'crowd_pattern':
      return crowdPatternFacts(env, core, pq);
    case 'll_price':
      return llPriceFacts(env, core, pq);
    case 'll_sellout':
      return llSelloutFacts(env, core, pq);
    case 'menu_price':
      return menuPriceFacts(env, core, pq);
    case 'menu_lookup':
      return menuLookupFacts(env, core, pq);
    case 'daw':
      return dawFacts(env, pq);
    case 'ride_height':
      return heightFacts(env, core, pq);
    case 'ride_toddler':
      return toddlerFacts(env, core, pq);
    case 'ride_indoor':
      return indoorFacts(env, core, pq);
    case 'ride_rain':
      return rainFacts(env, core, pq);
    case 'special_events':
      return eventsFacts(env, core, pq);
    case 'closures':
      return closuresFacts(env, core, pq);
    default:
      return { type: 'none', _quality: 0 };
  }
}

export function extraTemplate(pq: ParsedQuestion, facts: Facts): string {
  if (!(facts._quality > 0))
    return "Sorry — I couldn't find data to answer that one.";
  switch (pq.intent) {
    case 'crowd_pattern':
      return crowdPatternText(facts);
    case 'll_price':
      return llPriceText(facts);
    case 'll_sellout':
      return llSelloutText(facts);
    case 'menu_price':
      return menuPriceText(facts);
    case 'menu_lookup':
      return menuLookupText(facts);
    case 'daw':
      return dawText(facts);
    case 'ride_height':
      return heightText(facts);
    case 'ride_toddler':
      return toddlerText(facts);
    case 'ride_indoor':
      return indoorText(facts);
    case 'ride_rain':
      return rainText(facts);
    case 'special_events':
      return eventsText(facts);
    case 'closures':
      return closuresText(facts);
    default:
      return "Sorry — I couldn't find data to answer that one.";
  }
}

export async function extraLinks(
  _env: AnswerEnv,
  _core: Core,
  _pq: ParsedQuestion,
  facts: Facts
): Promise<Link[]> {
  return (facts._links as Link[] | undefined) ?? [];
}

const RIDE_TARGETED = new Set([
  'ride_height',
  'ride_indoor',
  'ride_rain',
  'closures',
  'll_sellout',
  'll_price',
]);

/**
 * Parse score for the new intents (same scale as parseScore). A list
 * question with no destination, park or ride named would silently default to
 * WDW, so it is scored 0.6 (silent); menu prices and the WDW-only data
 * (Lightning Lane, Drinking Around the World) keep a usable score.
 */
export function extraParseScore(pq: ParsedQuestion): number {
  if (pq.ride && RIDE_TARGETED.has(pq.intent)) return pq.ride.score;
  if (
    pq.matchScore !== null &&
    (pq.intent === 'menu_lookup' || pq.intent === 'menu_price')
  ) {
    return pq.matchScore;
  }
  if (pq.parkSlug) return 1.0;
  if (pq.destinationExplicit) return 0.85;
  // A height list states its resort, so the default (Walt Disney World) is visible.
  if (pq.intent === 'ride_height' && pq.heightIn !== null) return 0.85;
  if (['daw', 'll_price', 'll_sellout'].includes(pq.intent)) return 1.0;
  if (pq.intent === 'menu_price') return 0.85;
  return 0.6;
}
