// Small helpers that reproduce Python semantics the answers depend on:
// round() (ties to even), str.split(), date arithmetic and strftime names.

/**
 * Python's round(x, n): nearest, exact ties to even. toFixed rounds the exact
 * binary value (ties away from zero); only exact binary ties differ, and
 * those are detected from the exact decimal expansion.
 */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x)) return x;
  const exact = Math.abs(x).toFixed(Math.min(100, n + 40));
  const dot = exact.indexOf('.');
  const tail = exact.slice(dot + 1 + n);
  if (/^50*$/.test(tail)) {
    // exact tie: keep the even neighbour
    const scaled = Math.abs(x) * 10 ** n;
    const lo = Math.floor(scaled);
    const pick = lo % 2 === 0 ? lo : lo + 1;
    return (Math.sign(x) || 1) * (pick / 10 ** n);
  }
  return Number(x.toFixed(n));
}

/** Python int(round(x)). */
export function pyRoundInt(x: number): number {
  return Math.trunc(pyRound(x, 0));
}

/** Python str.split() word count. */
export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Slice by code points (Python str[:n]). */
export function cpSlice(s: string, n: number): string {
  const a = Array.from(s);
  return a.length <= n ? s : a.slice(0, n).join('');
}

// ---------------------------------------------------------------- dates
// A calendar date is an integer: days since 1970-01-01.

export type Day = number;
const MS_DAY = 86_400_000;

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** null when the date doesn't exist (Feb 30). */
export function mkDay(y: number, m: number, d: number): Day | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1 || y > 9999) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return Math.round(t / MS_DAY);
}

export function ymd(day: Day): { y: number; m: number; d: number } {
  const dt = new Date(day * MS_DAY);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  };
}

/** Python date.weekday(): Monday = 0. */
export function weekday(day: Day): number {
  return (new Date(day * MS_DAY).getUTCDay() + 6) % 7;
}

export function isoDay(day: Day): string {
  const { y, m, d } = ymd(day);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseIsoDay(s: string | null | undefined): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '');
  return m ? mkDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

export function monthAbbr(m: number): string {
  return (MONTH_NAMES[m - 1] ?? '').slice(0, 3);
}

/** "Wednesday, Oct 14" (bot_answer.fmt_day). */
export function fmtDay(day: Day): string {
  const { m, d } = ymd(day);
  return `${WEEKDAY_NAMES[weekday(day)]}, ${monthAbbr(m)} ${d}`;
}

/** "Oct 14" from an ISO date. */
export function shortIso(s: string): string {
  const day = parseIsoDay(s);
  if (day === null) return s;
  const { m, d } = ymd(day);
  return `${monthAbbr(m)} ${d}`;
}

/** "Oct 14, 2026" from an ISO date. */
export function longIso(s: string): string {
  const day = parseIsoDay(s);
  if (day === null) return s;
  const { y, m, d } = ymd(day);
  return `${monthAbbr(m)} ${d}, ${y}`;
}

/** Hour label like bot_parse._hour_label: 0 -> "12 AM", 13 -> "1 PM". */
export function hourLabel(h: number): string {
  const x = ((h % 24) + 24) % 24;
  if (x === 0) return '12 AM';
  if (x === 12) return '12 PM';
  return x < 12 ? `${x} AM` : `${x - 12} PM`;
}

/** Money in a destination currency: $12, $12.99, ¥1,200, €9.50. */
export function fmtMoney(symbol: string, v: number): string {
  const fixed = Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(2);
  const [int = '', frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${grouped}${frac ? `.${frac}` : ''}`;
}
