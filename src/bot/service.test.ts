import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDailySummary } from '../core/logic.js';
import { fixtureSource } from '../testutil/bundle.js';
import { askFromBundle, dailyFromBundle } from './service.js';
import { localToday, utcOffsetHours } from './tz.js';
import { isoDay } from './util.js';

// Python bot_summary.render_markdown on the same bundle (scripts/parity).
const DAILY = JSON.parse(
  readFileSync(
    join(process.cwd(), 'test', 'fixtures', 'daily_expected.json'),
    'utf8'
  )
) as Record<string, string>;

const NOW = new Date('2026-09-28T15:00:00Z');

void test('daily outlook markdown == Python bot_summary (WDW and DLR)', async () => {
  for (const dest of ['wdw', 'dlr'] as const) {
    const r = await dailyFromBundle(fixtureSource(), NOW, dest);
    assert.ok(r.ok, dest);
    assert.equal(r.data.markdown, DAILY[dest], dest);
  }
  const r = await dailyFromBundle(fixtureSource(), NOW, 'wdw');
  assert.ok(r.ok);
  const post = parseDailySummary(r.data, 'x');
  assert.equal(post?.title, "Today's Crowd Outlook — Monday, Sep 28");
});

void test('askFromBundle: answers; no bundle / stale bundle -> error, never a reply', async () => {
  const src = fixtureSource();
  const ok = await askFromBundle(
    src,
    NOW,
    'When is the best time to ride Slinky Dog Dash?'
  );
  assert.ok(ok.ok);
  assert.equal(ok.data.intent, 'best_time');
  assert.ok(ok.data.confidence >= 0.7);

  const none = await askFromBundle(null, NOW, 'x?');
  assert.deepEqual(none, { ok: false, error: 'bundle not loaded yet' });

  const stale = await askFromBundle(
    src,
    new Date('2026-10-20T00:00:00Z'),
    'Is MK busy tomorrow?'
  );
  assert.equal(stale.ok, false);
  assert.match((stale as { error: string }).error, /stale/);

  const statement = await askFromBundle(src, NOW, 'Trip report: we loved it.');
  assert.ok(statement.ok);
  assert.equal(statement.data.confidence, 0);
});

void test('park-local today for each destination (Tokyo is already tomorrow)', () => {
  const t = new Date('2026-09-28T17:50:00Z');
  assert.equal(isoDay(localToday('wdw', t)), '2026-09-28');
  assert.equal(isoDay(localToday('tdr', t)), '2026-09-29');
  assert.equal(isoDay(localToday('hkdl', t)), '2026-09-29');
  assert.equal(utcOffsetHours('dlr', t), -7);
  assert.equal(utcOffsetHours('dlr', new Date('2026-12-01T12:00:00Z')), -8);
  assert.equal(utcOffsetHours('dlp', t), 2);
  assert.equal(utcOffsetHours('dlp', new Date('2026-10-25T01:00:00Z')), 1); // EU DST ends Oct 25, 2026
});

void test('tz offsets agree with Intl for a year (US Pacific, Paris)', () => {
  for (const [dest, zone] of [
    ['dlr', 'America/Los_Angeles'],
    ['dlp', 'Europe/Paris'],
  ] as const) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    for (let h = 0; h < 365 * 24; h += 7) {
      const d = new Date(Date.UTC(2026, 0, 1) + h * 3_600_000);
      assert.equal(
        isoDay(localToday(dest, d)),
        fmt.format(d),
        `${dest} ${d.toISOString()}`
      );
    }
  }
});
