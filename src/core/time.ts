// America/New_York wall-clock math without relying on ICU time-zone data.
// Devvit's cron has no time-zone option (it is UTC), so the daily job runs
// hourly and asks "what hour is it in Eastern Time?" here.
//
// US rule since 2007: DST starts the 2nd Sunday of March at 02:00 local
// (07:00 UTC) and ends the 1st Sunday of November at 02:00 local (06:00 UTC).

const HOUR_MS = 60 * 60 * 1000;

/** UTC day-of-month of the nth Sunday of a month (month is 0-based). */
function nthSundayUtc(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstDow) % 7);
  return firstSunday + (n - 1) * 7;
}

/** True if `date` falls inside US Eastern daylight time. */
export function isEasternDst(date: Date): boolean {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 2, nthSundayUtc(y, 2, 2), 7); // 02:00 EST = 07:00 UTC
  const end = Date.UTC(y, 10, nthSundayUtc(y, 10, 1), 6); // 02:00 EDT = 06:00 UTC
  const t = date.getTime();
  return t >= start && t < end;
}

export type EtParts = {
  /** YYYY-MM-DD in Eastern Time. */
  dateKey: string;
  /** 0-23 hour in Eastern Time. */
  hour: number;
  /** Day of week, 0 = Sunday. */
  weekday: number;
  year: number;
  month: number; // 1-12
  day: number;
};

export function etParts(date: Date): EtParts {
  const offsetH = isEasternDst(date) ? -4 : -5;
  const local = new Date(date.getTime() + offsetH * HOUR_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const day = local.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
    hour: local.getUTCHours(),
    weekday: local.getUTCDay(),
    year,
    month,
    day,
  };
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** e.g. "Thursday, Sep 25" (Eastern Time). */
export function etDateLabel(date: Date): string {
  const p = etParts(date);
  return `${WEEKDAYS[p.weekday]}, ${MONTHS[p.month - 1]} ${p.day}`;
}

/**
 * Should the daily post go out now? True when the Eastern hour is within
 * [targetHour, targetHour + windowHours) on the same Eastern day and nothing
 * has been posted for that date yet. The window lets a missed hourly tick
 * catch up without posting late in the evening.
 */
export function shouldPostDaily(opts: {
  enabled: boolean;
  now: Date;
  targetHourET: number;
  windowHours: number;
  alreadyPostedForDate: boolean;
}): { post: boolean; reason: string; dateKey: string } {
  const p = etParts(opts.now);
  if (!opts.enabled)
    return { post: false, reason: 'disabled', dateKey: p.dateKey };
  if (opts.alreadyPostedForDate) {
    return { post: false, reason: 'already_posted', dateKey: p.dateKey };
  }
  if (
    p.hour < opts.targetHourET ||
    p.hour >= opts.targetHourET + opts.windowHours
  ) {
    return { post: false, reason: 'outside_window', dateKey: p.dateKey };
  }
  return { post: true, reason: 'due', dateKey: p.dateKey };
}
