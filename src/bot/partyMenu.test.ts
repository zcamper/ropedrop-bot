// Party (ticketed events) and menu-item answers vs the RopeDrop backend's own
// output for the same data (bot_party.py, bot_menu.py). Golden sets in
// test/fixtures/party_menu/: "fixture" = the backend's unit-test data
// (today Oct 26, 2026); "prod" = a real export with the backend's answers
// recorded at the same moment.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expected, partyMenuSource } from '../testutil/partyMenu.js';
import { analyzePost, type AnswerEnv } from './answer.js';
import { parseIsoDay } from './util.js';
import type { BundleSource } from './types.js';

const AS_OF = / From Disney's event pages as of [A-Z][a-z]{2} \d{1,2}\.$/;

async function envFor(src: BundleSource, set: string): Promise<AnswerEnv> {
  const exp = expected(set);
  return {
    src,
    common: await src.common(),
    now: new Date(exp.now),
    today: parseIsoDay(exp.today) as number,
  };
}

for (const set of ['fixture', 'prod']) {
  const exp = expected(set);
  for (const c of exp.cases) {
    void test(`[${set}] ${c.q}`, async () => {
      const env = await envFor(partyMenuSource(set), set);
      const r = await analyzePost(env, c.q);
      assert.equal(r.intent, c.intent, 'intent');
      assert.equal(r.confidence, c.confidence, 'confidence');
      if (c.confidence > 0.1) {
        if (c.intent === 'party' && c.answer) {
          // Same answer plus the capture date (the bundle is nightly).
          assert.match(r.answer, AS_OF);
          assert.equal(r.answer.replace(AS_OF, ''), c.answer);
        } else {
          assert.equal(r.answer, c.answer);
        }
        assert.deepEqual(
          r.links.map((l) => l.url),
          c.links
        );
      }
    });
  }
}

void test('party: a regular-day character is not a party question', async () => {
  const src = partyMenuSource('fixture', {
    parties: (_d, p) => ({ ...p, regular_characters: ['Mickey Mouse'] }),
  });
  const env = await envFor(src, 'fixture');
  const r = await analyzePost(env, 'Where can I meet Mickey?');
  assert.equal(r.intent, 'party');
  assert.ok(r.confidence < 0.7);
});

void test('party: a closed attraction listed as a party ride keeps the bot silent', async () => {
  const src = partyMenuSource('fixture', {
    parties: (_d, p) => {
      const ev = p.events['mickeys-very-merry-christmas-party'];
      if (!ev) return p;
      return {
        ...p,
        events: {
          ...p.events,
          'mickeys-very-merry-christmas-party': {
            ...ev,
            showtimes: ev.showtimes.filter((s) => s[2] !== 'Attraction'),
            offerings: [
              ...ev.offerings.filter((o) => o[0] !== 'ride'),
              ['ride', 'Splash Mountain', null],
            ],
          },
        },
      };
    },
  });
  const env = await envFor(src, 'fixture');
  const r = await analyzePost(
    env,
    'What rides are open at the Very Merry party?'
  );
  assert.equal(r.intent, 'party');
  assert.ok(r.confidence < 0.7, r.answer);
});

void test('party: without parties data the 14-day schedule answer is used', async () => {
  const base = partyMenuSource('fixture');
  const src: BundleSource = { ...base, parties: async () => null };
  const env = await envFor(src, 'fixture');
  const r = await analyzePost(
    env,
    'Is there a Halloween party at MK on Oct 30?'
  );
  assert.equal(r.intent, 'special_events');
});

void test('menu: a price question naming a restaurant keeps the restaurant price answer', async () => {
  const env = await envFor(partyMenuSource('fixture'), 'fixture');
  const r = await analyzePost(env, 'How much is a Dole Whip at Aloha Isle?');
  assert.equal(r.intent, 'menu_price');
});

void test('menu: Tokyo questions keep the menu price answer', async () => {
  const env = await envFor(partyMenuSource('fixture'), 'fixture');
  const r = await analyzePost(env, 'How much is a churro at Tokyo Disneyland?');
  assert.equal(r.intent, 'menu_price');
});

void test('menu: other intents keep their questions', async () => {
  const env = await envFor(partyMenuSource('fixture'), 'fixture');
  const cases: [string, string][] = [
    ['When is the best time to ride Slinky Dog Dash?', 'best_time'],
    ['What time does Magic Kingdom open on Oct 30?', 'park_hours'],
    ['What treats are at the Very Merry party?', 'party'],
    ['How much is the Multi Pass at Magic Kingdom on Oct 30?', 'll_price'],
    ['How much does Drinking Around the World cost?', 'daw'],
    ["What's on the breakfast menu at Be Our Guest?", 'menu_lookup'],
  ];
  for (const [q, intent] of cases) {
    const r = await analyzePost(env, q);
    assert.equal(r.parts[0]?.pq.intent, intent, q);
  }
});
