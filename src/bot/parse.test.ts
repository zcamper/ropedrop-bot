import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureSource } from '../testutil/bundle.js';
import { partialRatio, ratio } from './fuzz.js';
import {
  childHeight,
  parseDates,
  parseQuestion,
  seasonWindow,
  parseTimeWindow,
  questionSentences,
  splitSentences,
  stripMentions,
  type ParseEnv,
} from './parse.js';
import type { AnswerEnv } from './answer.js';
import { normalize, phraseSpans } from './text.js';
import type { Dest } from './types.js';
import { isoDay, mkDay, pyRound } from './util.js';

const TODAY = mkDay(2026, 9, 28) as number;

async function penv(): Promise<ParseEnv> {
  const src = fixtureSource();
  return {
    common: await src.common(),
    core: (d: Dest) => src.core(d),
    today: () => TODAY,
  };
}

void test('normalize matches bot_parse.normalize', () => {
  assert.equal(
    normalize("Mickey & Minnie's Runaway Railway"),
    'mickey and minnies runaway railway'
  );
  assert.equal(
    normalize('Soarin’ Around the World™'),
    'soarin around the world'
  );
  assert.equal(
    normalize('Star Wars: Rise of the Resistance'),
    'star wars rise of the resistance'
  );
  assert.equal(normalize('Café — 7DMT!!'), 'caf 7dmt');
  assert.equal(normalize(`a${String.fromCharCode(0x200b)}b`), 'ab');
});

void test('rapidfuzz ratio / partial_ratio reference values (rapidfuzz 3.14)', () => {
  const cases: [string, string, number, number][] = [
    [
      'flight of passage',
      'how long is the flight of passage wait in the afternoon',
      47.22222222222222,
      100,
    ],
    ['space mountain', 'what about spaceship earth', 35, 50],
    ['haunted mansion', 'haunted mansions', 96.7741935483871, 100],
    ['abcd', 'abdc', 75, 85.71428571428572],
    ['peter pans flight', 'peter pan flight', 96.96969696969697, 93.75],
    [
      'it s a small world',
      'its a small world at dl',
      82.92682926829268,
      97.14285714285714,
    ],
  ];
  for (const [a, b, r, pr] of cases) {
    assert.equal(ratio(a, b), r, `ratio ${a}|${b}`);
    assert.equal(partialRatio(a, b), pr, `partial ${a}|${b}`);
  }
  // Long needles (> 30 chars) use the DP path.
  const long = 'seven dwarfs mine train and big thunder mountain';
  assert.equal(
    ratio(long, 'seven dwarfs mine train'),
    ratio('seven dwarfs mine train', long)
  );
});

void test('pyRound: Python ties-to-even and exact decimal rounding', () => {
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
  assert.equal(pyRound(0.125, 2), 0.12);
  assert.equal(pyRound(0.675, 2), 0.68);
  assert.equal(pyRound(0.15 + 0.85 * 0.6, 2), 0.66);
});

void test('phraseSpans: longest phrase wins an overlap, text order', () => {
  assert.deepEqual(
    phraseSpans('rope drop space mountain then tron', [
      'space',
      'space mountain',
      'tron',
    ]).map((x) => x[2]),
    ['space mountain', 'tron']
  );
});

void test('mention stripping: u/ropedropplannerbot and the old u/ropedrop-bot', () => {
  assert.equal(
    stripMentions('u/ropedropplannerbot what time does MK open?'),
    'what time does MK open?'
  );
  assert.equal(
    stripMentions('/u/RopeDropPlannerBot, is Epcot busy?'),
    'is Epcot busy?'
  );
  assert.equal(
    stripMentions('hey u/ropedrop-bot: tron wait'),
    'hey   tron wait'
  );
  assert.equal(
    stripMentions('xu/ropedropplannerbot stays'),
    'xu/ropedropplannerbot stays'
  );
});

void test('sentence splitting and question gate', () => {
  assert.deepEqual(
    splitSentences('We land Oct. 12 at 9 a.m. Then MK! Is it busy?'),
    ['We land Oct. 12 at 9 a.m. Then MK!', 'Is it busy?']
  );
  const [sents, idx] = questionSentences(
    'Trip report: MK was packed. Tron broke down twice.'
  );
  assert.equal(sents.length, 2);
  assert.deepEqual(idx, []);
  assert.deepEqual(questionSentences('MK hours tomorrow')[1], [0]);
  assert.deepEqual(
    questionSentences('dole whip price at magic kingdom')[1],
    [0]
  );
});

void test('dates: ranges, weekdays in a window, the 14th, tomorrow', () => {
  const d = (tl: string) => parseDates(tl, normalize(tl), TODAY)[0].map(isoDay);
  assert.deepEqual(d('going oct 12-14'), [
    '2026-10-12',
    '2026-10-13',
    '2026-10-14',
  ]);
  assert.deepEqual(d('tomorrow'), ['2026-09-29']);
  assert.deepEqual(d('mondays in mid-october'), ['2026-10-12', '2026-10-19']);
  assert.deepEqual(d('10/3'), ['2026-10-03']);
  assert.deepEqual(d('next friday'), ['2026-10-02']);
  assert.deepEqual(parseTimeWindow('at 3', '3'), {
    start_hour: 15,
    end_hour: 15,
    label: '3 PM',
  });
});

void test('child height parsing', () => {
  assert.equal(childHeight('what can a 40-inch kid ride'), 40);
  assert.equal(childHeight('my son is 47 inches'), 47);
  assert.equal(childHeight('she is 42" tall'), 42);
  assert.equal(childHeight('he is 107 cm'), 42.1);
  assert.equal(childHeight('we waited 45 in line'), null);
});

void test('closed-rides list is WDW/DLR only: "splash" -> Tiana’s in WDW, Splash Mountain in Tokyo', async () => {
  const env = await penv();
  const wdw = await parseQuestion(
    env,
    'best time to ride splash mountain at magic kingdom?'
  );
  assert.equal(wdw.ride?.name, "Tiana's Bayou Adventure");
  const tdr = await parseQuestion(
    env,
    'best time to ride splash mountain at tokyo disneyland?'
  );
  assert.equal(tdr.destination, 'tdr');
  assert.equal(tdr.ride?.name, 'Splash Mountain');
  assert.equal(tdr.parkSlug, 'tokyo_disneyland');
});

void test('international nicknames resolve once the destination is known', async () => {
  const env = await penv();
  const hk = await parseQuestion(
    env,
    'Mystic Manor wait at Hong Kong Disneyland in the afternoon?'
  );
  assert.equal(hk.destination, 'hkdl');
  assert.equal(hk.ride?.name, 'Mystic Manor');
  const sh = await parseQuestion(
    env,
    'best time for tron at shanghai disneyland?'
  );
  assert.ok(sh.ride?.name.startsWith('TRON Lightcycle Power Run'));
  const paris = await parseQuestion(
    env,
    'is phantom manor busy at disneyland paris on saturday?'
  );
  assert.equal(paris.destination, 'dlp');
  assert.equal(paris.ride?.name, 'Phantom Manor');
  // Without a destination, "tron" is still Magic Kingdom's.
  const mk = await parseQuestion(env, 'tron wait?');
  assert.equal(mk.destination, 'wdw');
  assert.equal(mk.ride?.name, 'TRON Lightcycle / Run');
});

void test('"Tokyo Disneyland" is not Disneyland Resort', async () => {
  const env = await penv();
  const pq = await parseQuestion(env, 'Is Tokyo Disneyland crowded on Friday?');
  assert.equal(pq.destination, 'tdr');
  assert.equal(pq.parkSlug, 'tokyo_disneyland');
  assert.equal(pq.intent, 'crowds_on_date');
});

void test('seasonWindow: this/next winter, spring; bare "fall" and "winter break" do not match', () => {
  const oct24 = mkDay(2026, 10, 24) as number;
  const w = seasonWindow('this winter', oct24) as [number, number, string];
  assert.deepEqual([isoDay(w[0]), isoDay(w[1])], ['2026-12-01', '2027-02-28']);
  assert.match(w[2], /^this winter \(December 2026–February 2027\)$/);
  const jan10 = mkDay(2027, 1, 10) as number;
  const inside = seasonWindow('this winter', jan10) as [number, number, string];
  assert.deepEqual([isoDay(inside[0]), isoDay(inside[1])], ['2027-01-10', '2027-02-28']);
  const next = seasonWindow('next winter', jan10) as [number, number, string];
  assert.equal(isoDay(next[0]), '2027-12-01');
  assert.equal(isoDay((seasonWindow('in the spring', oct24) as [number, number, string])[0]), '2027-03-01');
  assert.equal(seasonWindow('the ride might fall', oct24), null);
  assert.equal(seasonWindow('crowds over winter break', oct24), null);
});

void test('mined-question misfires stay silent: opinion posts, a bare month as "today"', async () => {
  // 2026-10-24: real subreddit posts that got wrong replies.
  const src = fixtureSource();
  const { analyzePost } = await import('./answer.js');
  const e: AnswerEnv = { src, common: await src.common(), now: new Date('2026-09-28T18:00:00Z'), today: mkDay(2026, 9, 28) as number };
  for (const q of [
    'Is it crazy to say they should refurbish space mountain?',
    'November opening hours?\n\nAnyone know when November park closure times will be released?',
  ]) {
    const r = await analyzePost(e, q);
    assert.ok(r.confidence < 0.7, `${q} -> ${r.confidence} ${r.answer}`);
  }
});

void test('"any good time to ride X" is a best-time question (2026-10-26 Reddit)', async () => {
  const env = await penv();
  for (const q of [
    "Is there any good time to ride Tron? I've heard riding at night is just as bad as riding during the day because people want to see it lit up.",
    'When is a good time to do Haunted Mansion?',
    'Is there a better time for Slinky Dog?',
  ]) {
    const pq = await parseQuestion(env, q);
    assert.equal(pq.intent, 'best_time', q);
    assert.ok(pq.ride, q);
  }
  // "Have a good time" is not a question about timing.
  const bye = await parseQuestion(env, 'Have a good time at Tron tonight!');
  assert.notEqual(bye.intent, 'best_time');
});
