// Park-local wall-clock time for the six destinations without ICU time-zone
// data (same approach as core/time.ts): US and EU DST rules are built in,
// the Asian parks have fixed offsets.

import { isEasternDst } from '../core/time.js';
import { mkDay, type Day } from './util.js';
import type { Dest } from './types.js';

const HOUR_MS = 3_600_000;

function nthSundayUtc(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

function lastSundayUtc(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

/** US Pacific DST: 2nd Sunday of March 02:00 PST (10:00 UTC) to 1st Sunday of Nov 02:00 PDT (09:00 UTC). */
export function isPacificDst(date: Date): boolean {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 2, nthSundayUtc(y, 2, 2), 10);
  const end = Date.UTC(y, 10, nthSundayUtc(y, 10, 1), 9);
  const t = date.getTime();
  return t >= start && t < end;
}

/** EU summer time: last Sunday of March 01:00 UTC to last Sunday of October 01:00 UTC. */
export function isEuSummer(date: Date): boolean {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 2, lastSundayUtc(y, 2), 1);
  const end = Date.UTC(y, 9, lastSundayUtc(y, 9), 1);
  const t = date.getTime();
  return t >= start && t < end;
}

/** UTC offset in hours for a destination at an instant. */
export function utcOffsetHours(dest: Dest, date: Date): number {
  switch (dest) {
    case 'wdw':
      return isEasternDst(date) ? -4 : -5;
    case 'dlr':
      return isPacificDst(date) ? -7 : -8;
    case 'dlp':
      return isEuSummer(date) ? 2 : 1;
    case 'tdr':
      return 9;
    case 'hkdl':
    case 'shdr':
      return 8;
  }
}

export type LocalParts = { day: Day; hour: number; minute: number };

export function localParts(dest: Dest, date: Date): LocalParts {
  const local = new Date(date.getTime() + utcOffsetHours(dest, date) * HOUR_MS);
  return {
    day: mkDay(
      local.getUTCFullYear(),
      local.getUTCMonth() + 1,
      local.getUTCDate()
    ) as Day,
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

/** bot_parse.local_today. */
export function localToday(dest: Dest, now: Date): Day {
  return localParts(dest, now).day;
}
