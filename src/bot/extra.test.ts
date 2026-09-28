// New bundle-backed intents, against the frozen bundle snapshot
// (generation 20260928T1750Z, "today" = Mon Sep 28, 2026).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureSource } from '../testutil/bundle.js';
import { analyzePost, type AnswerEnv } from './answer.js';
import { mkDay } from './util.js';

type Case = {
  q: string;
  intent: string;
  reply: boolean;
  contains?: string[];
  link?: string;
  dest?: string;
};

const CASES: Case[] = [
  // a. crowd patterns (quietest day / weekday vs weekend / holidays), any of the 12 parks
  {
    q: "What's the quietest day of the week at Epcot?",
    intent: 'crowd_pattern',
    reply: true,
    contains: ['Quietest day at EPCOT: Wednesday', 'last 90 days'],
    link: 'https://ropedropplanner.com/wdw/epcot/crowd-by-day',
  },
  {
    q: 'Are weekends busier than weekdays at Disneyland?',
    intent: 'crowd_pattern',
    reply: true,
    contains: ['Weekends are not busier here', 'last 90 days'],
    link: 'https://ropedropplanner.com/dlr/disneyland/crowd-by-day',
  },
  {
    q: 'Is Hong Kong Disneyland busy during Chinese New Year?',
    intent: 'crowd_pattern',
    reply: true,
    dest: 'hkdl',
    contains: [
      'Mainland Spring Festival (Chinese New Year) (Feb 15–Feb 23, 2026)',
      '(+23%)',
      'Next: HK Lunar New Year school holidays',
    ],
    link: 'https://ropedropplanner.com/hkdl/crowd-by-day',
  },
  {
    q: 'Which day of the week is least crowded at Tokyo Disneyland?',
    intent: 'crowd_pattern',
    reply: true,
    dest: 'tdr',
    contains: ['Quietest day at Tokyo Disneyland: Friday'],
  },
  {
    q: 'Is Saturday or Sunday better at Shanghai Disneyland?',
    intent: 'crowd_pattern',
    reply: true,
    dest: 'shdr',
    contains: ['over the last 90 days'],
  },
  // WDW has no holiday dataset: stay silent rather than guess.
  {
    q: 'How busy is Magic Kingdom during Christmas?',
    intent: 'crowd_pattern',
    reply: false,
  },

  // b. Lightning Lane price (date/park) and sell-out time (ride), Eastern time
  {
    q: 'How much is Lightning Lane Multi Pass at Magic Kingdom on Oct 3?',
    intent: 'll_price',
    reply: true,
    contains: [
      'Magic Kingdom Saturday, Oct 3: $29',
      'Last checked Sep 28, 4:03 AM ET',
    ],
    link: 'https://ropedropplanner.com/wdw/lightning-lane/pricing',
  },
  {
    q: 'How much is the TRON single pass tomorrow?',
    intent: 'll_price',
    reply: true,
    contains: [
      'TRON Lightcycle / Run Lightning Lane Single Pass, per person — Tuesday, Sep 29: $19',
    ],
  },
  {
    q: 'When does Seven Dwarfs Mine Train single pass usually sell out on Fridays?',
    intent: 'll_sellout',
    reply: true,
    contains: [
      'sold out on 75% of the days it was on sale',
      'usually gone by about 3:45 PM ET',
      'On Fridays: gone on 92% of 13 days',
    ],
    link: 'https://ropedropplanner.com/wdw/lightning-lane/sellout-times',
  },
  {
    q: 'What time does the Flight of Passage Lightning Lane sell out?',
    intent: 'll_sellout',
    reply: true,
    contains: [
      'Avatar Flight of Passage Single Pass sold out on 16%',
      'Apr 11–Sep 28, 2026',
    ],
  },
  // No price captured that far out -> silent; no LL data outside WDW -> silent.
  {
    q: 'How much is Lightning Lane Multi Pass at Magic Kingdom on Dec 20?',
    intent: 'll_price',
    reply: false,
  },
  {
    q: 'How much is Lightning Lane at Tokyo Disneyland?',
    intent: 'll_price',
    reply: false,
    dest: 'tdr',
  },
  // Opinion: no time-saved data in the bundle -> silent.
  {
    q: 'Is Lightning Lane worth it for Slinky Dog Dash?',
    intent: 'other',
    reply: false,
  },
  {
    q: 'Should we buy Lightning Lane Multi Pass for Epcot?',
    intent: 'other',
    reply: false,
  },

  // c. menus, prices, Drinking Around the World
  {
    q: 'How much is a Dole Whip at Magic Kingdom?',
    intent: 'menu_price',
    reply: true,
    contains: ['"dole whip" at Magic Kingdom', 'from $5.79', 'last 30 days'],
  },
  {
    q: 'How much is a churro at Tokyo Disneyland?',
    intent: 'menu_price',
    reply: true,
    dest: 'tdr',
    contains: ['"churro" at Tokyo Disneyland', 'from ¥500'],
  },
  {
    q: "What's on the breakfast menu at Be Our Guest?",
    intent: 'menu_lookup',
    reply: true,
    contains: [
      "Be Our Guest Restaurant doesn't list a breakfast menu right now",
      'All Day, Dinner, Lunch',
    ],
    link: 'https://ropedropplanner.com/wdw/dining/be-our-guest-restaurant/menu',
  },
  {
    q: 'What does Space 220 serve for lunch?',
    intent: 'menu_lookup',
    reply: true,
    contains: ['Space 220 Lounge, Lunch'],
  },
  {
    q: 'How much does Drinking Around the World cost?',
    intent: 'daw',
    reply: true,
    contains: [
      '11 pavilions costs $159 at menu prices',
      'Japan: Violet Sake Slushie $14',
    ],
    link: 'https://ropedropplanner.com/wdw/drinking-around-the-world',
  },
  {
    q: "What's the Drinking Around the World drink in Japan?",
    intent: 'daw',
    reply: true,
    contains: ['Violet Sake Slushie ($14)'],
  },
  {
    q: 'Can anyone recommend a good table service restaurant in Epcot for dinner?',
    intent: 'other',
    reply: false,
  },

  // d. heights, indoor, toddlers, rain
  {
    q: 'What can a 40-inch kid ride at Disneyland?',
    intent: 'ride_height',
    reply: true,
    contains: [
      'a 40-inch child can ride Big Thunder Mountain Railroad (40 in)',
      'too short for Indiana Jones™ Adventure (46 in)',
    ],
    link: 'https://ropedropplanner.com/dlr/height-requirements',
  },
  {
    q: 'What is the height requirement for Big Grizzly Mountain in Hong Kong?',
    intent: 'ride_height',
    reply: true,
    dest: 'hkdl',
    contains: [
      'Big Grizzly Mountain Runaway Mine Cars has a 44-inch minimum height',
    ],
  },
  {
    q: 'What are the indoor rides at Epcot?',
    intent: 'ride_indoor',
    reply: true,
    contains: ['Indoor rides at EPCOT', 'Frozen Ever After'],
  },
  {
    q: 'Any toddler friendly rides at Magic Kingdom for a 2 year old?',
    intent: 'ride_toddler',
    reply: true,
    contains: [
      'no posted minimum height in our data',
      'Dumbo the Flying Elephant',
    ],
  },
  {
    q: 'Which rides close in the rain at Magic Kingdom?',
    intent: 'ride_rain',
    reply: true,
    contains: ['Magic Kingdom: The Barnstormer (2.45x)', 'Feb 27–Sep 26, 2026'],
  },
  {
    q: 'Does TRON close when it rains?',
    intent: 'ride_rain',
    reply: true,
    contains: ["isn't flagged as rain-sensitive", '1.28x'],
  },
  // No destination named: a list would silently assume WDW -> stay quiet.
  { q: 'What rides are indoors?', intent: 'ride_indoor', reply: false },

  // e. special events and closures
  {
    q: 'Is there a Halloween party at MK on Oct 9?',
    intent: 'special_events',
    reply: true,
    contains: [
      "Mickey's Not So Scary Halloween Party",
      '7:00 PM–12:00 AM on Fri Oct 9',
      'as of Sep 28',
    ],
    link: 'https://ropedropplanner.com/wdw/special-events',
  },
  {
    q: 'What special events are at Epcot this week?',
    intent: 'special_events',
    reply: true,
    contains: [
      'Extended Evening, 9:00 PM–11:00 PM on Mon Sep 28',
      'Food & Wine Festival',
    ],
  },
  {
    q: "What's closed for refurbishment at Magic Kingdom?",
    intent: 'closures',
    reply: true,
    contains: [
      "closed for refurbishment: Walt Disney's Carousel of Progress",
      'as of Sep 28, 1:48 PM ET',
    ],
    link: 'https://ropedropplanner.com/wdw/closures',
  },
  {
    q: 'What rides are closed at Hong Kong Disneyland right now?',
    intent: 'closures',
    reply: true,
    dest: 'hkdl',
    contains: [
      'closed for refurbishment: Hong Kong Disneyland Railroad - Main Street Station, Orbitron',
    ],
  },
  { q: 'Is Epcot closed tomorrow?', intent: 'closures', reply: false },

  // International rides: the closed list is WDW/DLR-only, intl aliases apply.
  {
    q: "What's the best time to ride Splash Mountain at Tokyo Disneyland?",
    intent: 'best_time',
    reply: true,
    dest: 'tdr',
    contains: ['Historically, Splash Mountain has its shortest waits'],
    link: 'https://ropedropplanner.com/tdr/attractions/splash-mountain-toky/best-time',
  },
  {
    q: 'What time does Hong Kong Disneyland open tomorrow?',
    intent: 'park_hours',
    reply: true,
    dest: 'hkdl',
    contains: ['Hong Kong Disneyland Tuesday, Sep 29'],
  },
];

async function env(): Promise<AnswerEnv> {
  const src = fixtureSource();
  return {
    src,
    common: await src.common(),
    now: new Date('2026-09-28T18:00:00Z'),
    today: mkDay(2026, 9, 28) as number,
  };
}

void test('new intents: intent, reply/silent, data-backed text, links', async () => {
  const e = await env();
  for (const c of CASES) {
    const r = await analyzePost(e, c.q);
    const part = r.parts[0];
    assert.ok(part, c.q);
    assert.equal(part.intent, c.intent, `${c.q} -> ${part.intent}`);
    assert.equal(
      r.confidence >= 0.7,
      c.reply,
      `${c.q}: confidence ${r.confidence}, answer: ${r.answer}`
    );
    if (c.dest) assert.equal(part.pq.destination, c.dest, c.q);
    for (const s of c.contains ?? [])
      assert.ok(
        r.answer.includes(s),
        `${c.q}\n  missing: ${s}\n  answer: ${r.answer}`
      );
    if (c.link)
      assert.ok(
        r.links.some((l) => l.url === c.link),
        `${c.q}: links ${JSON.stringify(r.links)}`
      );
    if (c.reply) assert.equal(part.guardViolations, 0, `${c.q}: number guard`);
  }
});

void test('every replied answer cites a window or an as-of date', async () => {
  const e = await env();
  const dated =
    /last \d+ days|as of|Last checked|last seen|tracked|20\d\d|Disney's schedule|Historically|from our ride data|in our data|minimum height|Hours can change/;
  for (const c of CASES.filter((x) => x.reply)) {
    const r = await analyzePost(e, c.q);
    assert.match(r.answer, dated, c.q);
  }
});

void test('multi-question post mixes an old and a new intent', async () => {
  const e = await env();
  const r = await analyzePost(
    e,
    'Heading to Magic Kingdom on Oct 9.\n\nWhat time does MK open that day? Also is there a Halloween party that night?'
  );
  assert.equal(r.intent, 'multi');
  assert.ok(r.answer.includes('**Park hours:**'));
  assert.ok(r.answer.includes('**Special events:**'));
  assert.ok(r.confidence >= 0.7);
});

void test('a stated child height carries over to the height question', async () => {
  const e = await env();
  const r = await analyzePost(
    e,
    'Does Space Mountain have a height requirement? My daughter is 43 inches.'
  );
  assert.equal(r.intent, 'ride_height');
  assert.ok(
    r.answer.includes(
      '44-inch minimum height, so a 43-inch child is 1 inch too short'
    ),
    r.answer
  );
});
