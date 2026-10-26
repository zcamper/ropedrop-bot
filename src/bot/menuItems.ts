// Food / drink item answers (intent "menu"), ported from the RopeDrop
// backend's bot_parse.detect_menu and bot_menu.py (2026-10-26): "What flavors
// of Dole Whip are available at Disney World?", "Where can I get a Dole Whip
// at Disneyland?", "Is the Mickey pretzel still at Magic Kingdom?", "How much
// is a churro at EPCOT?" -> what our menu data lists now, grouped by park /
// resort area with the stand names, plus what it has stopped listing.
//
// "Current" vs "not seen since" is the backend's rule (bot_menu.row_status:
// relative to each stand's own latest read per meal period, hidden rows gone,
// NULL last_seen = can't confirm). The exporter applies it, so each row in
// menu_items.json carries its status; this file only groups and words them.
// Resort-scoped: only the asked resort's file is read (WDW and DLR only).

import type { AnswerEnv, Facts, Link } from './answer.js';
import type { ParsedQuestion } from './parse.js';
import { closedNamed } from './party.js';
import type { Dest, MenuItemsFile } from './types.js';
import { monthAbbr, parseIsoDay, ymd } from './util.js';

export const MENU_DESTS: Dest[] = ['wdw', 'dlr'];
const MAX_ANSWER_CHARS = 1100;
const MAX_STAND_LINKS = 4;
const MAX_NOT_SEEN = 3;

// ---------------------------------------------------------------- parse (bot_parse.detect_menu)

const MENU_PATTERNS: [string, RegExp][] = [
  ['flavors', /\bflavou?rs? (?:of|for) (?:the |a |an )?(?<q>.+)/],
  [
    'flavors',
    /^(?:what|which|whats|how many|are there any|any)? ?(?:different |other |new |current )?(?<q>.+?) flavou?rs?\b/,
  ],
  [
    'where',
    /\bwhere (?:can|do|could|should|would|to) (?:i |we |you |one )?(?:still )?(?:get|find|buy|grab|order|try|eat|have) (?:a |an |the |some |any )?(?<q>.+)/,
  ],
  [
    'where',
    /\bwhere (?:is|are) (?:a |an |the )?(?<q>.+?) (?:sold|served|available|offered)\b/,
  ],
  [
    'where',
    /\bwhich (?:places?|stands?|spots?|restaurants?|carts?|kiosks?|locations?) (?:have|has|sell|sells|serve|serves|carry|carries) (?:a |an |the |any )?(?<q>.+)/,
  ],
  [
    'price',
    /\bhow much (?:is|are|does|do|was|were|for) (?:a |an |the |one )?(?<q>.+)/,
  ],
  ['price', /\b(?:price|prices|cost) (?:of|for) (?:a |an |the )?(?<q>.+)/],
  [
    'still',
    /\b(?:is|are) (?:the |a |an |there (?:still )?(?:a |an )?)?(?<q>.+?) still (?:available|at|sold|served|offered|on|in|around|a thing|there|being sold)\b/,
  ],
  [
    'still',
    /\b(?:is|are) (?:the |a |an )?(?<q>.+?) (?:still )?(?:available|sold|served|offered) (?:at|in|anywhere)\b/,
  ],
  [
    'still',
    /\b(?:do|does|can) (?:they|you|i|we|\w+(?: \w+){0,3}) (?:still )?(?:sell|serve|have|offer|carry) (?!to\b)(?:a |an |the |any )?(?<q>.+)/,
  ],
];
/** Words that end the item phrase ("dole whip | at disney world"). */
const MENU_CUT =
  /\s(?:at|in|on|from|near|around|inside|for|by|during|anywhere|available|still|anymore|any more|these days|right now|now|today|tonight|tomorrow|this|cost|costs|go for|are|is|was|were|do|does|can|could|will|would|should|they|there|and where|or where|if|that|which|with my|please)\b.*$/;
const MENU_STOP = new Set(
  'a an the some any of good best great favorite favourite new current other different disney disneys walt world wdw dlr disneyland resort park parks still get got me my our your you i we it one ones kind kinds type types sort sorts what which'.split(
    ' '
  )
);
/** Clear food/drink words: a menu question even when nothing matches (then silent). */
export const FOOD_WORDS = new Set(
  'dole whip churro pretzel popcorn icecream sundae cupcake cookie donut doughnut beignet waffle pizza burger cheeseburger turkey corndog nacho fries frie taco cocktail margarita beer wine coffee latte cappuccino espresso slush slushy slushie lemonade smoothie milkshake shake cake brownie croissant macaron pie funnel eggroll dumpling tenders nugget pastry cinnamon float cone softserve gelato sorbet poutine pierogi lumpia hotdog sandwich wrap salad soup punch tea boba juice cider sangria mimosa martini spritz tot tater'.split(
    ' '
  )
);
/** Single words too vague to be an item on their own ("where can I get food"). */
const MENU_VAGUE = new Set(
  'food snack drink dessert meal breakfast lunch dinner treat something stuff alcohol booze bar frozen float cone mickey cake pie tea wine beer coffee'.split(
    ' '
  )
);
/** Not menu items, whatever the sentence shape ("how much is a park ticket"). */
const NOT_MENU = new Set(
  'ticket pass lightning lane genie hotel room parking stroller wheelchair ecv reservation adr ride wait line queue tour package photopass'.split(
    ' '
  )
);

export function singularWord(w: string): string {
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w))
    return w.slice(0, -1);
  return w;
}

export type MenuDetect = {
  tokens: string[];
  flavors: boolean;
  price: boolean;
  kind: string;
  strong: boolean;
};

/** bot_parse.detect_menu. `parkAliases` = common.park_aliases keys. */
export function detectMenu(
  norm: string,
  parkAliases: Record<string, unknown>
): MenuDetect | null {
  let hit: [string, string] | null = null;
  for (const [kind, re] of MENU_PATTERNS) {
    const m = re.exec(norm);
    if (m?.groups?.q !== undefined) {
      hit = [kind, m.groups.q];
      break;
    }
  }
  if (!hit) return null;
  const [kind, q0] = hit;
  const q = ` ${q0}`.replace(MENU_CUT, '').trim();
  const words = q
    .split(/\s+/)
    .filter((w) => w && !MENU_STOP.has(w) && !(w in parkAliases));
  const tokens = words.filter((w) => w.length >= 3).map(singularWord);
  if (!tokens.length || tokens.length > 5) return null;
  if (tokens.length === 1 && MENU_VAGUE.has(tokens[0] as string)) return null;
  if (tokens.some((t) => NOT_MENU.has(t))) return null;
  const flavors = kind === 'flavors' || /\bflavou?rs?\b/.test(norm);
  const price =
    kind === 'price' || /\b(how much|price|prices|cost|costs)\b/.test(norm);
  const food = tokens.some((t) => FOOD_WORDS.has(t));
  return { tokens, flavors, price, kind, strong: food || kind === 'flavors' };
}

// ---------------------------------------------------------------- words / matching

/** Two-word flavors first. */
const FLAVOR_WORDS: string[][] = [
  ['key', 'lime'],
  ['blue', 'raspberry'],
  ['passion', 'fruit'],
  ['cotton', 'candy'],
  ['prickly', 'pear'],
  ...'pineapple orange strawberry mango cherry raspberry peach lime lemon watermelon coconut vanilla chocolate guava pumpkin apple grape banana pistachio lychee blackberry blueberry pomegranate dragonfruit citrus tangerine'
    .split(' ')
    .map((w) => [w]),
];

const AREA_LABELS: Record<string, [string, string][]> = {
  wdw: [
    ['magic_kingdom', 'Magic Kingdom'],
    ['epcot', 'EPCOT'],
    ['hollywood_studios', 'Hollywood Studios'],
    ['animal_kingdom', 'Animal Kingdom'],
    ['springs', 'Disney Springs'],
    ['resort', 'Resort hotels'],
    ['water', 'Water parks'],
    ['other', 'Elsewhere'],
  ],
  dlr: [
    ['disneyland', 'Disneyland Park'],
    ['california_adventure', 'California Adventure'],
    ['downtown', 'Downtown Disney'],
    ['resort', 'Resort hotels'],
    ['other', 'Elsewhere'],
  ],
};
const PARK_AREAS = new Set([
  'magic_kingdom',
  'epcot',
  'hollywood_studios',
  'animal_kingdom',
  'disneyland',
  'california_adventure',
]);

/** (original words, normalized words) of a name, aligned (bot_menu._words). */
function words(name: string): [string[], string[]] {
  const s = (name ?? '').replace(/[’‘]/g, "'").replace(/[®™©]/g, '');
  const orig = s.match(/[A-Za-z0-9]+(?:'[A-Za-z]+)?|&/g) ?? [];
  const norm = orig.map((w) =>
    w === '&' ? 'and' : w.toLowerCase().replace(/'/g, '')
  );
  return [orig, norm];
}

/** Span of the item tokens in a name (bot_menu.match_span). */
export function matchSpan(
  tokens: string[],
  nwords: string[]
): [number, number] | null {
  if (!tokens.length) return null;
  for (let i = 0; i < nwords.length; i++) {
    if (!(nwords[i] as string).startsWith(tokens[0] as string)) continue;
    let j = i + 1;
    let ok = true;
    for (const t of tokens.slice(1)) {
      if (j < nwords.length && (nwords[j] as string).startsWith(t)) j += 1;
      else if (j + 1 < nwords.length && (nwords[j + 1] as string).startsWith(t))
        j += 2;
      else {
        ok = false;
        break;
      }
    }
    if (ok) return [i, j];
  }
  return null;
}

/** bot_menu.flavor_of. */
export function flavorOf(
  nwords: string[],
  span: [number, number]
): string | null {
  const [i, j] = span;
  const tail = nwords.slice(j, j + 3);
  for (const fw of FLAVOR_WORDS) {
    if (fw.every((w, k) => tail[k] === w)) return fw.join(' ');
  }
  for (const fw of FLAVOR_WORDS) {
    const n = fw.length;
    if (i - n >= 0 && fw.every((w, k) => nwords[i - n + k] === w))
      return fw.join(' ');
  }
  return null;
}

function day(iso: string): string {
  const { m, d } = ymd(parseIsoDay(iso) as number);
  return `${monthAbbr(m)} ${d}`;
}

function money(v: number): string {
  const [int = '', frac = '00'] = v.toFixed(2).split('.');
  return `$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

function join(xs: string[], word = 'and'): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Python len(): code points. */
function plen(s: string): number {
  return Array.from(s).length;
}

function isUpperWord(w: string): boolean {
  return w === w.toUpperCase() && w !== w.toLowerCase();
}

// ---------------------------------------------------------------- data

type Row = {
  id: number;
  rid: string;
  name: string;
  norm: string;
  span: [number, number];
  orig: string[];
  price: number | null;
  status: 'current' | 'gone' | 'unknown';
  lastSeen: string | null; // "YYYY-MM-DDTHH:MM" park-local
  stand: string;
  area: string;
  place: string | null;
};

type Stands = MenuItemsFile['stands'];

async function loadFiles(
  env: AnswerEnv,
  dest: Dest
): Promise<MenuItemsFile[] | null> {
  if (!env.src.menuItemParts || !env.src.menuItems) return null;
  const n = await env.src.menuItemParts(dest);
  if (!n) return null;
  const out: MenuItemsFile[] = [];
  for (let i = 1; i <= n; i++) {
    const f = await env.src.menuItems(dest, i);
    if (f) out.push(f);
  }
  return out.length ? out : null;
}

const STATUS = { c: 'current', g: 'gone', u: 'unknown' } as const;

function loadRows(files: MenuItemsFile[], tokens: string[]): Row[] {
  const rows: Row[] = [];
  let id = 0;
  for (const f of files) {
    for (const [rid, s] of Object.entries(f.stands as Stands)) {
      for (const [name, price, st, seen] of s.items) {
        id += 1;
        const [orig, nw] = words(name);
        const span = matchSpan(tokens, nw);
        if (!span) continue;
        rows.push({
          id,
          rid,
          name: name.replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim(),
          norm: nw.join(' '),
          span,
          orig,
          price: price && price > 0 ? price : null,
          status: STATUS[st],
          lastSeen: seen,
          stand: (s.name ?? '').trim(),
          area: s.area,
          place: s.place,
        });
      }
    }
  }
  return rows;
}

/** Any menu row (WDW or DLR) whose name has the tokens in order (bot_parse._menu_name_exists). */
export async function menuNameExists(
  env: AnswerEnv,
  tokens: string[]
): Promise<boolean> {
  for (const d of MENU_DESTS) {
    const files = await loadFiles(env, d).catch(() => null);
    if (!files) continue;
    for (const f of files)
      for (const s of Object.values(f.stands))
        for (const it of s.items)
          if (matchSpan(tokens, words(it[0])[1])) return true;
  }
  return false;
}

// ---------------------------------------------------------------- facts (bot_menu.facts_menu)

function scope(
  env: AnswerEnv,
  pq: ParsedQuestion
): [Set<string> | null, string] {
  const dest = pq.destination;
  const resort = env.common.destinations[dest]?.name ?? dest;
  let parks = (
    pq.parks.length ? pq.parks : pq.parkSlug ? [pq.parkSlug] : []
  ).filter(Boolean);
  // Bare "Disneyland" usually means the resort for food.
  if (
    dest === 'dlr' &&
    parks.length === 1 &&
    parks[0] === 'disneyland' &&
    !` ${pq.normalized} `.includes(' disneyland park')
  ) {
    parks = [];
  }
  if (!parks.length) return [null, resort];
  const labels = Object.fromEntries(AREA_LABELS[dest] ?? []);
  const keep = new Set(parks.filter((p) => PARK_AREAS.has(p)));
  if (!keep.size) return [null, resort];
  return [
    keep,
    join(parks.filter((p) => keep.has(p)).map((p) => labels[p] ?? p)),
  ];
}

function displayItem(rows: Row[], tokens: string[]): string {
  let best: string | null = null;
  for (const r of rows) {
    const txt = r.orig.slice(r.span[0], r.span[1]).join(' ');
    if (best === null || plen(txt) < plen(best)) best = txt;
  }
  if (!best) return tokens.join(' ');
  const ws = best.split(' ');
  if (ws.some((w) => isUpperWord(w) && w.length > 1)) return best;
  return ws
    .map((w, k) =>
      k === 0 && !FOOD_WORDS.has(singularWord(w.toLowerCase()))
        ? w
        : w.toLowerCase()
    )
    .join(' ');
}

function dedupe(rows: Row[]): Row[] {
  const seen = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.rid}\u0000${r.norm}`;
    const cur = seen.get(k);
    if (!cur || (cur.price === null && r.price !== null)) seen.set(k, r);
  }
  return [...seen.values()];
}

function sortRows(rows: Row[], dest: string): Row[] {
  const order = new Map((AREA_LABELS[dest] ?? []).map(([k], i) => [k, i]));
  return rows
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        (order.get(a.r.area) ?? 99) - (order.get(b.r.area) ?? 99) ||
        cmp(a.r.stand.toLowerCase(), b.r.stand.toLowerCase()) ||
        plen(a.r.name) - plen(b.r.name) ||
        cmp(a.r.name, b.r.name) ||
        a.i - b.i
    )
    .map((o) => o.r);
}

function orderedUnique<T>(xs: T[]): T[] {
  const out: T[] = [];
  for (const x of xs) if (!out.includes(x)) out.push(x);
  return out;
}

function readLabel(a: string, b: string): string {
  if (a === b) return `menus read ${day(a)}`;
  if (a.slice(5, 7) === b.slice(5, 7)) {
    const { d } = ymd(parseIsoDay(b) as number);
    return `menus read ${day(a)}–${d}`;
  }
  return `menus read ${day(a)}–${day(b)}`;
}

type Stand = {
  rid: string;
  stand: string;
  area: string;
  place: string | null;
  rows: Row[];
};
type Group = { area: string; key: string; stands: Stand[] };

function lead(out: Facts, mode: string, disp: string, nStands: number): string {
  const sc = out.scope;
  if (mode === 'flavors') {
    const fl: string[] = out.flavors;
    const word = fl.length === 1 ? 'flavor' : 'flavors';
    return `Our menu data lists ${disp} in ${fl.length} ${word} at ${sc} (${out.read_label}): ${join(fl)}.`;
  }
  const where = nStands === 1 ? '1 stand' : `${nStands} stands`;
  return `Our menu data shows ${disp} on the menu at ${where} at ${sc} (${out.read_label}):`;
}

function standLabel(s: Stand): string {
  if (s.place && !s.stand.toLowerCase().includes(s.place.toLowerCase()))
    return `${s.stand} (${s.place})`;
  return s.stand;
}

function more(n: number): string {
  return n === 1 ? `${n} more stand` : `${n} more stands`;
}

function groupsText(
  groups: Group[],
  mode: string,
  flavored: Map<number, string | null>,
  maxStands: number,
  maxItems: number,
  price: boolean
): [string, number[], string[]] {
  const lines: string[] = [];
  const counts: number[] = [];
  const shown: string[] = [];
  for (const g of groups) {
    const take = g.stands.slice(0, maxStands);
    const extra = g.stands.length - maxStands;
    shown.push(...take.map((s) => s.rid));
    const parts: string[] = [];
    if (mode === 'flavors') {
      // Stands with the same flavors share one clause: "pineapple at A and B".
      const byFlv = new Map<string, [string[], string[]]>();
      for (const s of take) {
        const fl = orderedUnique(
          s.rows.map((r) => flavored.get(r.id)).filter((x): x is string => !!x)
        );
        const k = JSON.stringify(fl);
        const e = byFlv.get(k) ?? [fl, []];
        e[1].push(standLabel(s));
        byFlv.set(k, e);
      }
      for (const [fl, names] of byFlv.values()) {
        parts.push(
          fl.length
            ? `${join(fl)} at ${join(names)}`
            : `${join(names)} (no flavor named)`
        );
      }
    } else {
      for (const s of take) {
        const items = s.rows
          .slice(0, maxItems)
          .map((r) =>
            price && r.price ? `${r.name} ${money(r.price)}` : r.name
          );
        const m = s.rows.length - maxItems;
        if (m > 0) {
          items.push(`${m} more`);
          counts.push(m);
        }
        parts.push(`${standLabel(s)}: ${items.join(', ')}`);
      }
    }
    if (extra > 0) {
      parts.push(more(extra));
      counts.push(extra);
    }
    lines.push(`- **${g.area}:** ${parts.join('; ')}`);
  }
  return [lines.join('\n'), counts, shown];
}

function notSeenText(
  out: Facts,
  mode: string,
  disp: string,
  isLead: boolean
): string {
  const bits: string[] = [];
  const grouped = new Map<string, [string, string, number, string[]]>();
  for (const n of (out.not_seen ?? []) as Facts[]) {
    const k = JSON.stringify([n.stand, n.last_seen, n.days]);
    const e: [string, string, number, string[]] = grouped.get(k) ?? [
      n.stand,
      n.last_seen,
      n.days,
      [],
    ];
    e[3].push(n.what);
    grouped.set(k, e);
  }
  for (const [stand, d, days, whats] of grouped.values()) {
    if (mode === 'flavors') {
      bits.push(
        `Our menu data hasn't listed ${disp} ${join(whats, 'or')} in ${days} days (last at ${stand} on ${d}).`
      );
    } else {
      bits.push(
        `Our menu data hasn't listed ${join(whats, 'or')} at ${stand} since ${d} (${days} days).`
      );
    }
  }
  for (const u of (out.unconfirmed ?? []) as Facts[]) {
    const one = u.what.length === 1;
    bits.push(
      `Older rows also name ${join(u.what)} at ${u.stand}, but no recent menu read confirms ${one ? 'it' : 'them'}, so we can't say ${one ? 'it is' : 'they are'} still offered.`
    );
  }
  if (isLead && !bits.length) return '';
  return bits.join(' ');
}

const dateOf = (r: Row) => (r.lastSeen as string).slice(0, 10);

/**
 * bot_menu.facts_menu. Returns null when the bundle has no menu_items data
 * for the destination (older bundle, or not WDW/DLR): the caller falls back.
 */
export async function menuItemFacts(
  env: AnswerEnv,
  pq: ParsedQuestion
): Promise<Facts | null> {
  const out: Facts = { type: 'menu', _quality: 0.0 };
  const tokens = pq.menuQuery;
  const dest = pq.destination;
  if (!tokens.length || !AREA_LABELS[dest]) return null;
  const files = await loadFiles(env, dest);
  if (!files) return null;
  let rows = loadRows(files, tokens);
  const [keep, scopeLabel] = scope(env, pq);
  if (keep) rows = rows.filter((r) => keep.has(r.area));
  if (!rows.length) return out;
  const cur = dedupe(rows.filter((r) => r.status === 'current'));
  const gone = rows.filter((r) => r.status === 'gone');
  const unknown = rows.filter((r) => r.status === 'unknown');
  const disp = displayItem(
    cur.length ? cur : gone.length ? gone : unknown,
    tokens
  );
  Object.assign(out, { item: disp, scope: scopeLabel, destination: dest });

  const flavored = new Map<number, string | null>(
    rows.map((r) => [r.id, flavorOf(r.norm.split(' '), r.span)])
  );
  const mode =
    pq.menuFlavors && cur.some((r) => flavored.get(r.id)) ? 'flavors' : 'items';
  out.mode = mode;

  // What we've stopped seeing (flavors: no current row in scope lists it;
  // items: the stand itself no longer lists it).
  const key = (r: Row): string | null =>
    mode === 'flavors'
      ? (flavored.get(r.id) ?? null)
      : `${r.rid}\u0000${r.norm}`;
  const curKeys = new Set(cur.map(key).filter((k): k is string => !!k));
  const goneByKey = new Map<string, Row>();
  const goneSorted = gone
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) => cmp(a.r.lastSeen as string, b.r.lastSeen as string) || a.i - b.i
    )
    .map((o) => o.r);
  for (const r of goneSorted) {
    const k = key(r);
    if (k && !curKeys.has(k)) {
      goneByKey.set(k, r); // latest wins; like a Python dict, keeps its first slot
    }
  }
  const unknownKeys = new Map<string, string[]>();
  if (mode === 'flavors') {
    for (const r of unknown) {
      const k = key(r);
      if (k && !curKeys.has(k) && !goneByKey.has(k)) {
        const arr = unknownKeys.get(r.stand) ?? [];
        if (!arr.includes(k)) arr.push(k);
        unknownKeys.set(r.stand, arr);
      }
    }
  }
  const today = pq.today;
  const notSeen = [...goneByKey.entries()]
    .map(([k, r], i) => ({ k, r, i }))
    .sort(
      (a, b) => cmp(b.r.lastSeen as string, a.r.lastSeen as string) || a.i - b.i
    )
    .map(({ k, r }) => {
      const d = dateOf(r);
      return {
        what: mode === 'flavors' ? k : r.name,
        stand: r.stand,
        last_seen: day(d),
        date: d,
        days: today - (parseIsoDay(d) as number),
      };
    });
  out.not_seen = notSeen.slice(0, MAX_NOT_SEEN);
  out.unconfirmed = [...unknownKeys.entries()]
    .map(([stand, what]) => ({ stand, what }))
    .slice(0, 2);

  if (!cur.length) {
    // Only gone / unknown rows: say so, but stay below the reply threshold.
    out.groups = [];
    const txt = notSeenText(out, mode, disp, true);
    out._answer = txt;
    out._quality = txt ? 0.4 : 0.0;
    return guard(env, pq, out);
  }

  const reads = [...new Set(cur.map(dateOf))].sort();
  const r0 = reads[0] as string;
  const r1 = reads[reads.length - 1] as string;
  out.read_dates = [day(r0), day(r1)];
  out.read_label = readLabel(r0, r1);
  if (mode === 'flavors') {
    const byStands = new Map<string, Set<string>>();
    for (const r of cur) {
      const f = flavored.get(r.id);
      if (f) {
        const s = byStands.get(f) ?? new Set<string>();
        s.add(r.rid);
        byStands.set(f, s);
      }
    }
    out.flavors = [...byStands.keys()].sort(
      (a, b) =>
        (byStands.get(b) as Set<string>).size -
          (byStands.get(a) as Set<string>).size || cmp(a, b)
    );
    out.flavor_count = out.flavors.length;
  }

  const labels = Object.fromEntries(AREA_LABELS[dest] as [string, string][]);
  const stands = new Map<string, Stand>();
  for (const r of sortRows(cur, dest)) {
    let st = stands.get(r.rid);
    if (!st) {
      st = {
        rid: r.rid,
        stand: r.stand,
        area: r.area,
        place: r.place,
        rows: [],
      };
      stands.set(r.rid, st);
    }
    st.rows.push(r);
  }
  const groups: Group[] = [];
  for (const [a] of AREA_LABELS[dest] as [string, string][]) {
    const sts = [...stands.values()].filter((s) => s.area === a);
    if (sts.length)
      groups.push({ area: labels[a] as string, key: a, stands: sts });
  }

  // The "not listed since" sentence is the point of a flavors or "is X still
  // there?" question; for "where can I get X" / prices it only fits if room.
  const tail = notSeenText(out, mode, disp, false);
  const tails =
    mode === 'flavors' || pq.menuKind === 'still' ? [tail] : [tail, ''];
  let text = '';
  let counts: number[] = [];
  let shown: string[] = [];
  let t = '';
  const fits = (ms: number) =>
    plen(text) <= MAX_ANSWER_CHARS &&
    (ms >= 3 || t === tails[tails.length - 1]);
  let ms = 0;
  outer: for (t of tails) {
    for (const [maxStands, maxItems] of [
      [4, 3],
      [3, 2],
      [3, 1],
      [2, 1],
      [1, 1],
    ] as [number, number][]) {
      ms = maxStands;
      let body: string;
      [body, counts, shown] = groupsText(
        groups,
        mode,
        flavored,
        maxStands,
        maxItems,
        pq.menuPrice
      );
      text = `${lead(out, mode, disp, stands.size)}\n\n${body}${t ? `\n\n${t}` : ''}`;
      if (fits(maxStands)) break outer;
    }
    if (fits(ms)) break;
  }
  if (t === '' && tail) {
    out.not_seen = [];
    out.unconfirmed = [];
  }
  out.shown_counts = [...counts, stands.size];
  out.stand_count = stands.size;
  out.groups = groups.map((g) => ({
    area: g.area,
    stands: g.stands.map((s) => ({
      stand: s.stand,
      place: s.place,
      flavors: orderedUnique(
        s.rows.map((r) => flavored.get(r.id)).filter((x): x is string => !!x)
      ),
      items: s.rows.map((r) => ({ name: r.name, price: r.price })),
    })),
  }));
  out._answer = text;
  out._quality = 1.0;
  out._stand_order = shown;
  out._stand_urls = Object.fromEntries(
    files.flatMap((f) =>
      Object.entries(f.stands)
        .filter(([rid]) => stands.has(rid))
        .map(([rid, s]) => [rid, [s.name.trim(), s.menu_url]])
    )
  );
  out._links_cfg = (files[0] as MenuItemsFile).links;
  out._price = pq.menuPrice;
  out._park_scope = keep ? [...keep].sort() : [];
  return guard(env, pq, out);
}

function guard(env: AnswerEnv, pq: ParsedQuestion, out: Facts): Facts {
  const text: string = out._answer ?? '';
  if (text && out._quality && closedNamed(env.common, pq.destination, text)) {
    out._quality = 0.0;
    out._guard_failed = true;
  }
  return out;
}

export function menuItemText(facts: Facts): string {
  return (facts._answer as string) ?? '';
}

/** bot_menu.menu_links: each named stand's menu page (max 4) + the area page. */
export function menuItemLinks(facts: Facts): Link[] {
  if (facts.type !== 'menu' || !facts._stand_order?.length) return [];
  const links: Link[] = [];
  const urls = facts._stand_urls as Record<string, [string, string | null]>;
  for (const rid of facts._stand_order as string[]) {
    const [name, url] = urls[rid] ?? ['', null];
    if (url && links.length < MAX_STAND_LINKS)
      links.push({ title: `${name} menu and prices`, url });
  }
  const cfg = facts._links_cfg as MenuItemsFile['links'];
  const parks = facts._park_scope as string[];
  const snack =
    parks.length === 1 ? cfg.snack_tour[parks[0] as string] : undefined;
  if (facts.destination === 'wdw' && snack && !facts._price) links.push(snack);
  else if (cfg.food_prices) links.push(cfg.food_prices);
  const seen = new Set<string>();
  return links.filter((l) => !seen.has(l.url) && !!seen.add(l.url));
}
