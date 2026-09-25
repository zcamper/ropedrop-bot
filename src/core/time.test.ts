import assert from 'node:assert/strict';
import { test } from 'node:test';
import { etDateLabel, etParts, isEasternDst, shouldPostDaily } from './time.js';

void test('isEasternDst around the 2026 transitions', () => {
  // 2026: DST starts Sun Mar 8 07:00 UTC, ends Sun Nov 1 06:00 UTC.
  assert.equal(isEasternDst(new Date('2026-03-08T06:59:59Z')), false);
  assert.equal(isEasternDst(new Date('2026-03-08T07:00:00Z')), true);
  assert.equal(isEasternDst(new Date('2026-11-01T05:59:59Z')), true);
  assert.equal(isEasternDst(new Date('2026-11-01T06:00:00Z')), false);
  assert.equal(isEasternDst(new Date('2026-01-15T12:00:00Z')), false);
  assert.equal(isEasternDst(new Date('2026-07-04T12:00:00Z')), true);
});

void test('etParts: 7:00 ET is 11:00 UTC in summer and 12:00 UTC in winter', () => {
  assert.deepEqual(
    {
      d: etParts(new Date('2026-09-25T11:00:00Z')).dateKey,
      h: etParts(new Date('2026-09-25T11:00:00Z')).hour,
    },
    { d: '2026-09-25', h: 7 }
  );
  const w = etParts(new Date('2026-12-10T12:00:00Z'));
  assert.equal(w.dateKey, '2026-12-10');
  assert.equal(w.hour, 7);
});

void test('etParts: UTC midnight is still the previous day in ET', () => {
  const p = etParts(new Date('2026-09-26T02:30:00Z'));
  assert.equal(p.dateKey, '2026-09-25');
  assert.equal(p.hour, 22);
});

void test('etParts agrees with Intl America/New_York across a whole year', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const start = Date.UTC(2026, 0, 1);
  for (let t = start; t < start + 366 * 24 * 3600e3; t += 3600e3) {
    const d = new Date(t);
    const parts = Object.fromEntries(
      fmt.formatToParts(d).map((x) => [x.type, x.value])
    );
    const want = `${parts.year}-${parts.month}-${parts.day} ${Number(parts.hour)}`;
    const p = etParts(d);
    assert.equal(`${p.dateKey} ${p.hour}`, want, d.toISOString());
  }
});

void test('etDateLabel', () => {
  assert.equal(etDateLabel(new Date('2026-09-25T15:00:00Z')), 'Friday, Sep 25');
});

void test('shouldPostDaily: posts inside [target, target+window) once per ET day', () => {
  const base = {
    enabled: true,
    targetHourET: 7,
    windowHours: 3,
    alreadyPostedForDate: false,
  };
  const at = (iso: string) => shouldPostDaily({ ...base, now: new Date(iso) });
  assert.equal(at('2026-09-25T10:00:00Z').reason, 'outside_window'); // 6 ET
  assert.equal(at('2026-09-25T11:00:00Z').post, true); // 7 ET
  assert.equal(at('2026-09-25T13:00:00Z').post, true); // 9 ET (catch-up)
  assert.equal(at('2026-09-25T14:00:00Z').reason, 'outside_window'); // 10 ET
  assert.equal(at('2026-12-10T12:00:00Z').post, true); // 7 EST
  assert.equal(at('2026-12-10T11:00:00Z').post, false); // 6 EST
  assert.equal(
    shouldPostDaily({
      ...base,
      now: new Date('2026-09-25T11:00:00Z'),
      alreadyPostedForDate: true,
    }).reason,
    'already_posted'
  );
  assert.equal(
    shouldPostDaily({
      ...base,
      enabled: false,
      now: new Date('2026-09-25T11:00:00Z'),
    }).reason,
    'disabled'
  );
});
