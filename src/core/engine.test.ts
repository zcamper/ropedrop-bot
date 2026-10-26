import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { normalizeSettings, type BotSettings } from './config.js';
import {
  handleComment,
  handlePost,
  outcomeToast,
  runDaily,
  runWeekly,
  type Deps,
  type PostEvent,
  type AskResponse,
  type ReplyMarker,
  type Result,
  type Store,
} from './engine.js';

// ---------------------------------------------------------------- fakes

class MemStore implements Store {
  replied = new Map<string, ReplyMarker>();
  locks = new Set<string>();
  replies: { id: string; t: number }[] = [];
  async getReplied(id: string) {
    return this.replied.get(id);
  }
  async setReplied(id: string, m: ReplyMarker) {
    this.replied.set(id, m);
  }
  async tryLock(key: string) {
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }
  async unlock(key: string) {
    this.locks.delete(key);
  }
  async countRecentReplies(now: number, win: number) {
    this.replies = this.replies.filter((r) => r.t > now - win);
    return this.replies.length;
  }
  async recordReply(id: string, now: number) {
    this.replies.push({ id, t: now });
  }
}

type World = {
  deps: Deps;
  store: MemStore;
  comments: { parent: string; text: string }[];
  posts: { title: string; text: string; sticky: boolean }[];
  asked: string[];
  logs: string[];
  settings: Partial<BotSettings>;
  askResult: Result<AskResponse>;
  summaryResult: Result<{ markdown: string }>;
  weeklyCalls: string[];
  weeklyResult: Result<{ title: string; body: string }>;
  mods: Set<string>;
  visible: boolean;
  now: Date;
};

function makeWorld(): World {
  const w = {
    store: new MemStore(),
    comments: [],
    posts: [],
    asked: [],
    logs: [],
    settings: { dryRun: false },
    askResult: {
      ok: true,
      data: {
        answer: 'Rope drop Slinky.',
        confidence: 0.8,
        links: [],
        intent: 'best_time',
      },
    },
    summaryResult: {
      ok: true,
      data: { markdown: "## Today's Crowd Outlook — Friday, Sep 25\n\n| a |" },
    },
    weeklyCalls: [],
    weeklyResult: { ok: true, data: { title: 'What changed', body: 'Back open: X' } },
    mods: new Set<string>(['modperson']),
    visible: true,
    now: new Date('2026-09-25T11:05:00Z'), // 7:05 ET
  } as unknown as World;
  w.deps = {
    settings: async () => normalizeSettings(w.settings),
    botUsername: async () => 'ropedrop-bot',
    isModerator: async (u) => w.mods.has(u.toLowerCase()),
    isStillVisible: async () => w.visible,
    ask: async (_s, q) => {
      w.asked.push(q);
      return w.askResult;
    },
    dailySummary: async () => w.summaryResult,
    weeklyPost: async (kind, dest, dateKey) => {
      w.weeklyCalls.push(`${kind}:${dest}:${dateKey}`);
      return w.weeklyResult;
    },
    submitComment: async (parent, text) => {
      w.comments.push({ parent, text });
      return `t1_reply${w.comments.length}`;
    },
    submitPost: async (title, text, sticky) => {
      w.posts.push({ title, text, sticky });
      return 't3_daily';
    },
    store: w.store,
    now: () => w.now,
    log: {
      info: (m) => w.logs.push(m),
      warn: (m) => w.logs.push(m),
      error: (m) => w.logs.push(m),
    },
  };
  return w;
}

const postEv = (over: Partial<PostEvent> = {}): PostEvent => ({
  id: 't3_p1',
  title: 'When should we do Tron?',
  body: 'MK on Tuesday',
  authorName: 'visitor',
  flairText: 'Question',
  deleted: false,
  spam: false,
  ...over,
});

let w: World;
beforeEach(() => {
  w = makeWorld();
});

// ---------------------------------------------------------------- auto path

void test('auto post: replies once with footer; dedupes redelivery', async () => {
  const o1 = await handlePost(w.deps, postEv(), 'auto');
  assert.equal(o1.status, 'replied');
  assert.equal(w.comments.length, 1);
  assert.equal(w.comments[0]!.parent, 't3_p1');
  assert.ok(w.comments[0]!.text.startsWith('Rope drop Slinky.\n\n---\n'));
  assert.equal(w.asked[0], 'When should we do Tron?\n\nMK on Tuesday');

  const o2 = await handlePost(w.deps, postEv(), 'auto');
  assert.equal(o2.status, 'duplicate');
  assert.equal(w.comments.length, 1);
  assert.equal(w.asked.length, 1);
});

void test('auto: low confidence -> no reply', async () => {
  w.askResult = {
    ok: true,
    data: { answer: 'meh', confidence: 0.69, links: [], intent: 'x' },
  };
  const o = await handlePost(w.deps, postEv(), 'auto');
  assert.deepEqual(o, {
    status: 'low_confidence',
    confidence: 0.69,
    threshold: 0.7,
  });
  assert.equal(w.comments.length, 0);
});

void test('auto: data unavailable (no bundle / stale / read error) -> log only, nothing posted', async () => {
  for (const error of [
    'bundle not loaded yet',
    'bundle is stale',
    'chunk missing',
  ]) {
    w = makeWorld();
    w.askResult = { ok: false, error };
    const o = await handlePost(w.deps, postEv(), 'auto');
    assert.equal(o.status, 'error');
    assert.equal(w.comments.length, 0);
    assert.ok(w.logs.some((l) => l.includes(error.replace(/ /g, '_'))));
  }
});

void test('auto: mod author, skip flair, bot author are skipped before calling the API', async () => {
  assert.equal(
    (await handlePost(w.deps, postEv({ authorName: 'ModPerson' }), 'auto'))
      .status,
    'skipped'
  );
  assert.equal(
    (await handlePost(w.deps, postEv({ flairText: 'Trip Report' }), 'auto'))
      .status,
    'skipped'
  );
  assert.equal(
    (await handlePost(w.deps, postEv({ authorName: 'ropedrop-bot' }), 'auto'))
      .status,
    'skipped'
  );
  assert.equal(w.asked.length, 0);
});

void test('auto: removed between event and reply -> skipped', async () => {
  w.visible = false;
  const o = await handlePost(w.deps, postEv(), 'auto');
  assert.deepEqual(o, { status: 'skipped', reason: 'deleted_or_removed' });
  assert.equal(w.asked.length, 0);
});

void test('auto: hourly cap counts actual replies', async () => {
  w.settings.maxRepliesPerHour = 2;
  for (let i = 1; i <= 3; i++) {
    const o = await handlePost(w.deps, postEv({ id: `t3_p${i}` }), 'auto');
    assert.equal(o.status, i <= 2 ? 'replied' : 'capped');
  }
  // Low-confidence answers don't consume the cap.
  w = makeWorld();
  w.settings.maxRepliesPerHour = 1;
  w.askResult = {
    ok: true,
    data: { answer: 'x', confidence: 0.1, links: [], intent: 'x' },
  };
  await handlePost(w.deps, postEv({ id: 't3_a' }), 'auto');
  w.askResult = {
    ok: true,
    data: { answer: 'y', confidence: 0.9, links: [], intent: 'x' },
  };
  assert.equal(
    (await handlePost(w.deps, postEv({ id: 't3_b' }), 'auto')).status,
    'replied'
  );
  // Window rolls: an hour later the cap frees up.
  assert.equal(
    (await handlePost(w.deps, postEv({ id: 't3_c' }), 'auto')).status,
    'capped'
  );
  w.now = new Date(w.now.getTime() + 3600e3 + 1);
  assert.equal(
    (await handlePost(w.deps, postEv({ id: 't3_c' }), 'auto')).status,
    'replied'
  );
});

void test('auto: dryRun logs instead of posting and marks id so it is not re-asked', async () => {
  w.settings.dryRun = true;
  const o = await handlePost(w.deps, postEv(), 'auto');
  assert.equal(o.status, 'dry_run');
  assert.equal(w.comments.length, 0);
  assert.ok(
    w.logs.some((l) => l.includes('DRY RUN') && l.includes('Rope drop Slinky.'))
  );
  assert.equal(
    (await handlePost(w.deps, postEv(), 'auto')).status,
    'duplicate'
  );
});

void test('auto: default settings are dry run (fresh install cannot post)', async () => {
  w.settings = {};
  assert.equal((await handlePost(w.deps, postEv(), 'auto')).status, 'dry_run');
  assert.equal(w.comments.length, 0);
});

void test('auto comment: mention required; question has mention stripped; reply goes to comment', async () => {
  const quiet = await handleComment(
    w.deps,
    {
      id: 't1_c0',
      body: 'no mention',
      authorName: 'v',
      deleted: false,
      spam: false,
    },
    'auto'
  );
  assert.equal(quiet.status, 'skipped');
  const o = await handleComment(
    w.deps,
    {
      id: 't1_c1',
      body: 'U/RopeDrop-Bot is EPCOT busy Friday?',
      authorName: 'v',
      deleted: false,
      spam: false,
    },
    'auto'
  );
  assert.equal(o.status, 'replied');
  assert.equal(w.asked[0], 'is EPCOT busy Friday?');
  assert.equal(w.comments[0]!.parent, 't1_c1');
});

void test('bare summon (link form) answers the parent comment; reply goes under the summon', async () => {
  // 2026-10-26 r/RopeDropPlanner: "u/bot" replying to "Is there any good time to ride
  // Tron?" arrived as a profile link and got a generic rope-drop answer.
  const parents: string[] = [];
  w.deps.parentText = async (id) => {
    parents.push(id);
    return id === 't1_q' ? 'Is there any good time to ride Tron? u/ropedrop-bot' : undefined;
  };
  const o = await handleComment(
    w.deps,
    {
      id: 't1_summon',
      body: '[u/ropedrop-bot](https://www.reddit.com/user/ropedrop-bot/)',
      authorName: 'v',
      deleted: false,
      spam: false,
      parentId: 't1_q',
    },
    'auto'
  );
  assert.equal(o.status, 'replied');
  assert.deepEqual(parents, ['t1_q']);
  assert.equal(w.asked[0], 'Is there any good time to ride Tron?');
  assert.equal(w.comments[0]!.parent, 't1_summon');
  assert.match(w.logs.at(-1)!, /question=parent/);

  // Parent gone (or the bot's own comment): nothing to answer, API not called.
  const gone = await handleComment(
    w.deps,
    { id: 't1_s2', body: 'u/ropedrop-bot', authorName: 'v', deleted: false, spam: false, parentId: 't1_x' },
    'auto'
  );
  assert.deepEqual(gone, { status: 'skipped', reason: 'empty_question' });
  assert.equal(w.asked.length, 1);
});

void test('handler never throws: Reddit failure becomes an error outcome', async () => {
  w.deps.submitComment = async () => {
    throw new Error('RATELIMIT');
  };
  const o = await handlePost(w.deps, postEv(), 'auto');
  assert.deepEqual(o, { status: 'error', message: 'RATELIMIT' });
});

// ---------------------------------------------------------------- manual (mod menu)

void test('manual: bypasses flair skip and hourly cap, floor is 0.5 not minConfidence', async () => {
  w.settings.maxRepliesPerHour = 0;
  w.settings.minConfidence = 0.9;
  w.askResult = {
    ok: true,
    data: { answer: 'ok', confidence: 0.55, links: [], intent: 'x' },
  };
  const o = await handlePost(w.deps, postEv({ flairText: 'Meta' }), 'manual');
  assert.equal(o.status, 'replied');
  assert.match(outcomeToast(o), /^Replied/);
});

void test('manual: confidence below the 0.5 hard floor -> no reply', async () => {
  w.askResult = {
    ok: true,
    data: { answer: 'ok', confidence: 0.49, links: [], intent: 'x' },
  };
  const o = await handlePost(w.deps, postEv(), 'manual');
  assert.deepEqual(o, {
    status: 'low_confidence',
    confidence: 0.49,
    threshold: 0.5,
  });
  assert.match(outcomeToast(o), /^Low confidence/);
});

void test('manual: still never replies twice; can answer after a dry-run marker', async () => {
  await handlePost(w.deps, postEv(), 'auto');
  const o = await handlePost(w.deps, postEv(), 'manual');
  assert.equal(o.status, 'duplicate');
  assert.equal(w.comments.length, 1);

  w = makeWorld();
  w.settings.dryRun = true;
  await handlePost(w.deps, postEv(), 'auto');
  w.settings.dryRun = false;
  assert.equal(
    (await handlePost(w.deps, postEv(), 'manual')).status,
    'replied'
  );
});

void test('outcomeToast covers error without leaking details', () => {
  assert.equal(
    outcomeToast({ status: 'error', message: 'secret stuff' }).includes(
      'secret'
    ),
    false
  );
});

// ---------------------------------------------------------------- daily

void test('daily: posts once per ET day inside the window', async () => {
  const o1 = await runDaily(w.deps);
  assert.deepEqual(o1, {
    status: 'posted',
    postId: 't3_daily',
    dateKey: '2026-09-25',
  });
  assert.deepEqual(w.posts[0], {
    title: "Today's Crowd Outlook — Friday, Sep 25",
    text: '| a |',
    sticky: false,
  });
  w.now = new Date('2026-09-25T12:05:00Z');
  assert.deepEqual(await runDaily(w.deps), {
    status: 'skipped',
    reason: 'already_posted',
  });
  assert.equal(w.posts.length, 1);
});

void test('daily: outside window / disabled -> skipped, API not called', async () => {
  let called = 0;
  w.deps.dailySummary = async () => {
    called++;
    return w.summaryResult;
  };
  w.now = new Date('2026-09-25T09:00:00Z'); // 5 ET
  assert.deepEqual(await runDaily(w.deps), {
    status: 'skipped',
    reason: 'outside_window',
  });
  w.now = new Date('2026-09-25T11:00:00Z');
  w.settings.dailyPostEnabled = false;
  assert.deepEqual(await runDaily(w.deps), {
    status: 'skipped',
    reason: 'disabled',
  });
  assert.equal(called, 0);
});

void test('daily: API error releases the claim so the next tick retries', async () => {
  w.summaryResult = { ok: false, error: 'bundle not loaded yet' };
  assert.equal((await runDaily(w.deps)).status, 'error');
  assert.equal(w.posts.length, 0);
  w.summaryResult = { ok: true, data: { markdown: '## T\n\nB' } };
  w.now = new Date('2026-09-25T12:00:00Z');
  assert.equal((await runDaily(w.deps)).status, 'posted');
});

void test('daily: dryRun logs the post; sticky flag passes through', async () => {
  w.settings.dryRun = true;
  assert.equal((await runDaily(w.deps)).status, 'dry_run');
  assert.equal(w.posts.length, 0);
  assert.ok(
    w.logs.some(
      (l) => l.includes('DRY RUN') && l.includes("Today's Crowd Outlook")
    )
  );

  w = makeWorld();
  w.settings.dailyPostSticky = true;
  await runDaily(w.deps);
  assert.equal(w.posts[0]!.sticky, true);
});

// ---------------------------------------------------------------- one log line per event

const botLines = (w: World) => w.logs.filter((l) => l.startsWith('[bot] '));

void test('log: exactly one line per post/comment/mention, with outcome, intent, confidence, dest and data source', async () => {
  w.settings.dryRun = true;
  w.askResult = {
    ok: true,
    data: {
      answer: 'Rope drop Slinky.',
      confidence: 0.8,
      links: [],
      intent: 'best_time',
      destination: 'wdw',
      source: 'embedded:20260928T1750Z',
    },
  };
  await handlePost(w.deps, postEv(), 'auto');
  const dry = botLines(w).filter((l) => !l.includes('DRY RUN'));
  assert.deepEqual(dry, [
    '[bot] post t3_p1 mode=auto outcome=dry_run intent=best_time confidence=0.8 dest=wdw data=embedded:20260928T1750Z',
  ]);

  w = makeWorld();
  w.askResult = {
    ok: true,
    data: {
      answer: 'x',
      confidence: 0.3,
      links: [],
      intent: 'park_hours',
      destination: 'dlr',
      source: 'redis:G9',
    },
  };
  await handlePost(w.deps, postEv(), 'auto');
  assert.deepEqual(botLines(w), [
    '[bot] post t3_p1 mode=auto outcome=silent reason=low_confidence(0.3<0.7) intent=park_hours confidence=0.3 dest=dlr data=redis:G9',
  ]);

  w = makeWorld();
  await handlePost(w.deps, postEv({ authorName: 'ModPerson' }), 'auto');
  await handleComment(
    w.deps,
    {
      id: 't1_c9',
      body: 'nice trip!',
      authorName: 'visitor',
      deleted: false,
      spam: false,
    },
    'auto'
  );
  w.askResult = { ok: false, error: 'bundle not loaded yet' };
  await handleComment(
    w.deps,
    {
      id: 't1_c10',
      body: 'u/ropedrop-bot is MK busy tomorrow?',
      authorName: 'visitor',
      deleted: false,
      spam: false,
    },
    'auto'
  );
  assert.deepEqual(botLines(w), [
    '[bot] post t3_p1 mode=auto outcome=skipped reason=author_is_mod',
    '[bot] comment t1_c9 mode=auto outcome=skipped reason=no_mention',
    '[bot] mention t1_c10 mode=auto outcome=silent reason=error:no_data:_bundle_not_loaded_yet',
  ]);
});

void test('log: never contains the post text or the author name', async () => {
  const secret = 'Zebra42 Quokka';
  for (const dryRun of [true, false]) {
    w = makeWorld();
    w.settings.dryRun = dryRun;
    await handlePost(
      w.deps,
      postEv({ title: `${secret}?`, body: secret, authorName: 'SecretUser9' }),
      'auto'
    );
    await handleComment(
      w.deps,
      {
        id: 't1_s',
        body: `u/ropedrop-bot ${secret}?`,
        authorName: 'SecretUser9',
        deleted: false,
        spam: false,
      },
      'auto'
    );
    for (const l of w.logs) {
      assert.ok(!l.includes('Zebra42') && !l.includes('SecretUser9'), l);
    }
  }
});

void test('mention by a moderator is answered (posts by mods are still skipped)', async () => {
  const o = await handleComment(
    w.deps,
    {
      id: 't1_m1',
      body: 'u/ropedrop-bot when is Slinky shortest?',
      authorName: 'modperson',
      deleted: false,
      spam: false,
    },
    'auto'
  );
  assert.equal(o.status, 'replied');
  assert.equal(
    (await handlePost(w.deps, postEv({ authorName: 'modperson' }), 'auto'))
      .status,
    'skipped'
  );
});

// ---------------------------------------------------------------- weekly posts

const MON_9_ET = new Date('2026-10-26T13:05:00Z'); // Monday 9:05 EDT
const FRI_9_ET = new Date('2026-10-30T13:05:00Z'); // Friday 9:05 EDT

void test('weekly: off by default (a mod turns each post on)', async () => {
  w.now = FRI_9_ET;
  const out = await runWeekly(w.deps);
  assert.deepEqual(out.map((o) => o.status === 'skipped' && o.reason), ['disabled', 'disabled']);
  assert.equal(w.weeklyCalls.length, 0);
});

void test('weekly: Friday posts one changes post per resort, once', async () => {
  w.settings.weeklyChangesEnabled = true;
  w.now = FRI_9_ET;
  const out = await runWeekly(w.deps);
  assert.deepEqual(out.map((o) => `${o.dest}:${o.status}`), ['wdw:posted', 'dlr:posted']);
  assert.deepEqual(w.weeklyCalls, ['weekly_changes:wdw:2026-10-30', 'weekly_changes:dlr:2026-10-30']);
  assert.equal(w.posts.length, 2);
  assert.equal(w.posts[0]?.sticky, false);
  w.now = new Date('2026-10-30T14:05:00Z');
  const again = await runWeekly(w.deps);
  assert.ok(again.every((o) => o.status === 'skipped' && o.reason === 'already_posted'));
  assert.equal(w.posts.length, 2);
});

void test('weekly: Monday questions post; other days and hours do nothing', async () => {
  w.settings.weeklyQuestionsEnabled = true;
  w.settings.weeklyChangesEnabled = true;
  w.now = MON_9_ET;
  const out = await runWeekly(w.deps);
  assert.deepEqual(out.map((o) => `${o.kind}:${o.status}`), ['weekly_questions:posted']);
  w.now = new Date('2026-10-27T13:05:00Z'); // Tuesday
  assert.deepEqual(await runWeekly(w.deps), []);
  w.now = new Date('2026-10-30T11:05:00Z'); // Friday 7 ET, before the 9 ET window
  assert.ok((await runWeekly(w.deps)).every((o) => o.status === 'skipped' && o.reason === 'outside_window'));
});

void test('weekly: nothing to post keeps the claim; a data error releases it', async () => {
  w.settings.weeklyChangesEnabled = true;
  w.now = FRI_9_ET;
  w.weeklyResult = { ok: false, error: 'nothing_to_post (nothing_changed)' };
  const out = await runWeekly(w.deps);
  assert.ok(out.every((o) => o.status === 'skipped' && o.reason === 'nothing_to_post'));
  assert.ok(w.store.locks.has('weekly:weekly_changes:wdw:2026-10-30'));

  w.store.locks.clear();
  w.weeklyResult = { ok: false, error: 'bundle not loaded yet' };
  assert.ok((await runWeekly(w.deps)).every((o) => o.status === 'error'));
  assert.equal(w.store.locks.size, 0);
  assert.equal(w.posts.length, 0);
});

void test('weekly: dryRun logs instead of posting', async () => {
  w.settings.weeklyChangesEnabled = true;
  w.settings.dryRun = true;
  w.now = FRI_9_ET;
  const out = await runWeekly(w.deps);
  assert.ok(out.every((o) => o.status === 'dry_run'));
  assert.equal(w.posts.length, 0);
  assert.ok(w.logs.some((l) => l.includes('DRY RUN') && l.includes('What changed')));
});
