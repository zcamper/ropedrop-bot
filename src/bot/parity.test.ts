// Parity with the Python backend (bot_parse / bot_answer) on the 29 fixture
// posts. test/fixtures/parity_expected.json holds, per post, the Python
// output on the same frozen bundle (scripts/parity/gen_expected.py):
//   legacy — the Python code as it is today;
//   fixed  — the Python code + the two documented fixes (scripts/parity/fixes.py):
//            A. sparse after-close hours ignored in best/worst-hour ranking,
//            B. "which ride first" from the opening-rush 15-minute profile;
//   prod_legacy — the Python code on the live database (decision only).
// The TypeScript bot must equal `fixed` exactly (answer text, confidence,
// intent, links), except for the posts NEW_INTENTS lists, which the new
// bundle-backed intents now answer on purpose.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureSource } from '../testutil/bundle.js';
import { analyzePost, type AnswerEnv } from './answer.js';
import { mkDay } from './util.js';

type Out = {
  reply: boolean;
  confidence: number;
  intent: string;
  answer: string;
  links: string[];
};
type Post = {
  id: string;
  text: string;
  legacy: Out;
  fixed: Out;
  prod_legacy: { reply: boolean };
};

const GOLD = JSON.parse(
  readFileSync(
    join(process.cwd(), 'test', 'fixtures', 'parity_expected.json'),
    'utf8'
  )
) as {
  posts: Post[];
};

/** Intentional differences from the Python bot (see README "Parity"). */
const NEW_INTENTS: Record<
  string,
  { intent: string; reply: boolean; contains: string[] }
> = {
  // Python: height questions were "opinion" (silent). Now a data answer.
  height_tron: {
    intent: 'ride_height',
    reply: true,
    contains: ['48-inch minimum height', '47-inch child is 1 inch too short'],
  },
  // Python: Tokyo was unsupported (silent). The bundle has TDR holiday data.
  tokyo_golden_week: {
    intent: 'crowd_pattern',
    reply: true,
    contains: [
      'Golden Week (Apr 29–May 6, 2026) at Tokyo DisneySea',
      '(+8%)',
      'Next: Golden Week, Apr 29–May 5, 2027',
    ],
  },
};

/** Posts where fixes A/B change the Python output itself (legacy != fixed). */
const FIX_CHANGES = [
  'live4_dlr_rise_or_indy',
  'title_body_slinky_or_rise',
  'bullet_plan_make_sense',
];

async function env(): Promise<AnswerEnv> {
  const src = fixtureSource();
  return {
    src,
    common: await src.common(),
    now: new Date('2026-09-28T18:00:00Z'),
    today: mkDay(2026, 9, 28) as number,
    threshold: 0.7,
  };
}

void test('fixture has the 29 posts, and the bundle-backed Python matches Python on the live DB', () => {
  assert.equal(GOLD.posts.length, 29);
  for (const p of GOLD.posts) {
    assert.equal(
      p.legacy.reply,
      p.prod_legacy.reply,
      `${p.id}: bundle vs live DB decision`
    );
  }
});

void test('fixes A/B change exactly the documented posts', () => {
  const top = (o: Out) =>
    JSON.stringify([o.reply, o.confidence, o.intent, o.answer, o.links]);
  const changed = GOLD.posts
    .filter((p) => top(p.legacy) !== top(p.fixed))
    .map((p) => p.id);
  assert.deepEqual(changed, FIX_CHANGES);
});

void test('29 posts: TypeScript == Python (fixed) — answer, confidence, intent, links', async () => {
  const e = await env();
  for (const p of GOLD.posts) {
    const r = await analyzePost(e, p.text);
    const got: Out = {
      reply: r.confidence >= 0.7,
      confidence: r.confidence,
      intent: r.intent,
      answer: r.answer,
      links: r.links.map((l) => l.url),
    };
    const special = NEW_INTENTS[p.id];
    if (special) {
      assert.equal(got.intent, special.intent, p.id);
      assert.equal(got.reply, special.reply, p.id);
      for (const s of special.contains)
        assert.ok(got.answer.includes(s), `${p.id}: "${s}" in ${got.answer}`);
      assert.equal(p.fixed.reply, false, `${p.id} was silent in Python`);
      continue;
    }
    assert.deepEqual(
      got,
      {
        reply: p.fixed.reply,
        confidence: p.fixed.confidence,
        intent: p.fixed.intent,
        answer: p.fixed.answer,
        links: p.fixed.links,
      },
      p.id
    );
  }
});

void test('fix B: ride order now uses the opening-rush profile and says so', async () => {
  const e = await env();
  const post = GOLD.posts.find(
    (p) => p.id === 'title_body_slinky_or_rise'
  ) as Post;
  const r = await analyzePost(e, post.text);
  assert.ok(
    r.answer.startsWith('Over the last 60 days on a typical weekday, '),
    r.answer
  );
  assert.ok(r.answer.includes('at opening to ~60 by 2 hours after opening'));
  assert.equal(post.legacy.reply, false);
  assert.equal(r.confidence >= 0.7, true);
});

void test('fix A: a time-of-day wait question is answered (0.66 -> 0.95)', async () => {
  const e = await env();
  const r = await analyzePost(e, 'Flight of Passage wait in the afternoon');
  assert.equal(r.intent, 'best_time');
  assert.equal(r.confidence, 0.95);
  assert.equal(
    r.answer,
    'Historically, Avatar Flight of Passage averages about 50 min in the afternoon (12 PM-5 PM). ' +
      'Its shortest waits are around 7 PM (about 34 min) and it peaks around 11 AM (about 66 min).'
  );
});
