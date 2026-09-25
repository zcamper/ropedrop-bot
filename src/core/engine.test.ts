import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { ApiResult, AskResponse } from './api.js';
import { normalizeSettings, type BotSettings } from './config.js';
import {
  handleComment,
  handlePost,
  outcomeToast,
  runDaily,
  type Deps,
  type PostEvent,
  type ReplyMarker,
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
  askResult: ApiResult<AskResponse>;
  summaryResult: ApiResult<unknown>;
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
    settings: { dryRun: false, botKey: 'k' },
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

void test('auto: API error (401/429/503) -> log only, nothing posted', async () => {
  for (const status of [401, 429, 503]) {
    w = makeWorld();
    w.askResult = { ok: false, error: { kind: 'http', status } };
    const o = await handlePost(w.deps, postEv(), 'auto');
    assert.equal(o.status, 'error');
    assert.equal(w.comments.length, 0);
    assert.ok(w.logs.some((l) => l.includes(`HTTP ${status}`)));
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
  w.settings = { botKey: 'k' };
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
  w.summaryResult = { ok: false, error: { kind: 'http', status: 503 } };
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
