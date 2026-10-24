import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDailySummary } from '../core/logic.js';
import { fixtureSource } from '../testutil/bundle.js';
import {
  weeklyFromSources,
  askFromBundle,
  askFromSources,
  dailyFromBundle,
  dailyFromSources,
} from './service.js';
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
    new Date('2026-11-05T00:00:00Z'),
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

// ---------------------------------------------------------------- old snapshot, later dates

// The fixture was built 2026-09-28 (hours 30 d, crowds 60 d, events 14 d).
// Three weeks later (e.g. an embedded snapshot while the daily fetch is
// unavailable) it must still answer what it covers, date its schedule, and
// stay silent beyond its coverage.
const LATER = new Date('2026-10-20T16:00:00Z'); // noon ET, Tue Oct 20

async function ask(now: Date, q: string) {
  const r = await askFromBundle(fixtureSource(), now, q);
  assert.ok(r.ok, q);
  return r.data;
}

void test('old snapshot: dates beyond its coverage stay silent (hours, crowds, LL prices, events, closures)', async () => {
  for (const q of [
    'What are Magic Kingdom hours on Nov 5?',
    'Is Magic Kingdom busy on Dec 15?',
    'How much is Lightning Lane Multi Pass at Magic Kingdom on Nov 10?',
    'Are there any special events at Magic Kingdom this week?',
    "What's closed for refurb at Magic Kingdom?",
  ]) {
    const a = await ask(LATER, q);
    assert.ok(a.confidence < 0.5, `${q} -> ${a.confidence}: ${a.answer}`);
  }
});

void test('old snapshot: hours for today are dated, never presented as current', async () => {
  const fresh = await ask(NOW, 'What are Magic Kingdom hours today?');
  assert.ok(fresh.confidence >= 0.7);
  assert.doesNotMatch(fresh.answer, /as of/);

  const later = await ask(LATER, 'What are Magic Kingdom hours today?');
  assert.ok(later.confidence >= 0.7, later.answer);
  assert.match(later.answer, /^Magic Kingdom Tuesday, Oct 20: /);
  assert.match(later.answer, /published schedule as of Sep 28/);
  assert.doesNotMatch(later.answer, /\btoday\b/i);

  const crowd = await ask(LATER, 'Is Magic Kingdom busy tomorrow?');
  assert.match(crowd.answer, /Wednesday, Oct 21: .*Forecast as of Sep 28/);
});

void test("old snapshot: no daily 'Today's Crowd Outlook' from data older than today", async () => {
  const r = await dailyFromBundle(fixtureSource(), LATER, 'wdw');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /older than today/);
});

void test('askFromSources: first working source wins and is named; falls back on error', async () => {
  const good = { src: fixtureSource(), label: 'embedded:G1' };
  const broken = {
    src: Object.assign(fixtureSource(), {
      common: () => Promise.reject(new Error('chunk missing')),
    }),
    label: 'redis:G2',
  };
  const q = 'When is the best time to ride Slinky Dog Dash?';
  const r = await askFromSources([broken, good], NOW, q);
  assert.ok(r.ok);
  assert.equal(r.data.source, 'embedded:G1');
  assert.equal(r.data.destination, 'wdw');
  const none = await askFromSources([], NOW, q);
  assert.deepEqual(none, { ok: false, error: 'bundle not loaded yet' });
  const bad = await askFromSources([broken], NOW, q);
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /redis:G2: answer failed/);
  const d = await dailyFromSources([good], NOW, 'wdw');
  assert.ok(d.ok);
  assert.equal(d.data.source, 'embedded:G1');
});

// ---------------------------------------------------------------- weekly posts (2026-10-24)

function withPosts(posts: unknown) {
  return { src: Object.assign(fixtureSource(), { posts: async () => posts }), label: 'redis:G2' };
}
const CHANGES = {
  kind: 'posts',
  dest: 'wdw',
  generated_at: '2026-10-30T08:15:00Z',
  weekly_changes: {
    ok: true,
    date: '2026-10-30',
    title: 'What changed at Walt Disney World this week (Friday, Oct 30)',
    markdown: '## What changed at Walt Disney World this week (Friday, Oct 30)\n\n**Back open**\n* X',
  },
};

void test('weekly: posts the bundle markdown without its heading line', async () => {
  const r = await weeklyFromSources([withPosts(CHANGES)], 'weekly_changes', 'wdw', '2026-10-30');
  assert.ok(r.ok);
  assert.equal(r.data.title, CHANGES.weekly_changes.title);
  assert.equal(r.data.body, '**Back open**\n* X');
});

void test('weekly: a post built for another day is never posted', async () => {
  const r = await weeklyFromSources([withPosts(CHANGES)], 'weekly_changes', 'wdw', '2026-11-06');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.error.startsWith('nothing_to_post'));
});

void test('weekly: ok=false from the server means nothing to post', async () => {
  const quiet = { ...CHANGES, weekly_changes: { ok: false, reason: 'nothing_changed', date: '2026-10-30', title: null, markdown: null } };
  const r = await weeklyFromSources([withPosts(quiet)], 'weekly_changes', 'wdw', '2026-10-30');
  assert.ok(!r.ok && r.error === 'nothing_to_post (nothing_changed)');
});

void test('weekly: bundles from before posts.json fall through to an error', async () => {
  const r = await weeklyFromSources([{ src: fixtureSource(), label: 'embedded:G1' }], 'weekly_changes', 'wdw', '2026-10-30');
  assert.ok(!r.ok && r.error.includes('no weekly_changes'));
});
