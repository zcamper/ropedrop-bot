import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCommentQuestion,
  buildPostQuestion,
  buildReplyBody,
  capCheck,
  isFlairSkipped,
  meetsConfidence,
  mentionsBot,
  parseDailySummary,
  shouldHandleComment,
  shouldHandlePost,
  stripMention,
  MAX_COMMENT_CHARS,
  type CommentCandidate,
  type PostCandidate,
} from './logic.js';
import { parseSkipFlairs } from './config.js';

const BOT = 'ropedrop-bot';
const FEEDBACK =
  'https://www.reddit.com/message/compose?to=/r/ropedropplanner&subject=RopeDrop%20bot%20feedback';
const SKIP = parseSkipFlairs('Trip Report, Photo, Photos, Meta');

const post = (over: Partial<PostCandidate> = {}): PostCandidate => ({
  id: 't3_abc',
  title: 'Best time for Slinky Dog?',
  body: 'Going Tuesday.',
  authorName: 'someuser',
  flairText: 'Question',
  deleted: false,
  spam: false,
  authorIsMod: false,
  ...over,
});

const comment = (over: Partial<CommentCandidate> = {}): CommentCandidate => ({
  id: 't1_xyz',
  body: 'u/ropedrop-bot when is Space Mountain shortest?',
  authorName: 'someuser',
  deleted: false,
  spam: false,
  authorIsMod: false,
  ...over,
});

// ---------------------------------------------------------------- mentions

void test('mentionsBot: case-insensitive, with or without leading slash', () => {
  assert.equal(mentionsBot('hey u/RopeDrop-Bot help', BOT), true);
  assert.equal(mentionsBot('hey /u/ropedrop-bot help', BOT), true);
  assert.equal(mentionsBot('u/ropedrop-bot', BOT), true);
  assert.equal(mentionsBot('(u/ropedrop-bot)', BOT), true);
});

void test('mentionsBot: rejects look-alike usernames and bare names', () => {
  assert.equal(mentionsBot('u/ropedrop-bot2 help', BOT), false);
  assert.equal(mentionsBot('u/ropedrop-bot_x help', BOT), false);
  assert.equal(mentionsBot('xu/ropedrop-bot', BOT), false);
  assert.equal(mentionsBot('ropedrop-bot help', BOT), false);
  assert.equal(mentionsBot(undefined, BOT), false);
});

void test('stripMention removes every mention and tidies whitespace', () => {
  assert.equal(
    stripMention(
      'u/ropedrop-bot  when is   Tron  shortest? /u/RopeDrop-Bot',
      BOT
    ),
    'when is Tron shortest?'
  );
  assert.equal(
    stripMention('Hi u/ropedrop-bot, thoughts?', BOT),
    'Hi , thoughts?'
  );
});

// ---------------------------------------------------------------- questions

void test('buildPostQuestion joins title and body with a blank line', () => {
  assert.equal(buildPostQuestion(' Title ', ' Body '), 'Title\n\nBody');
  assert.equal(buildPostQuestion('Title only', ''), 'Title only');
  assert.equal(buildPostQuestion('Title only', undefined), 'Title only');
});

void test('buildPostQuestion truncates to 2000 chars without splitting emoji', () => {
  const q = buildPostQuestion('T', '😀'.repeat(3000));
  assert.equal(Array.from(q).length, 2000);
  assert.ok(!q.includes('�'));
});

void test('buildCommentQuestion strips the mention', () => {
  assert.equal(
    buildCommentQuestion('u/ropedrop-bot is EPCOT busy?', BOT),
    'is EPCOT busy?'
  );
});

// ---------------------------------------------------------------- shouldHandlePost

void test('shouldHandlePost: normal question post is handled', () => {
  assert.deepEqual(
    shouldHandlePost(post(), { botUsername: BOT, skipFlairs: SKIP }),
    {
      handle: true,
    }
  );
});

void test('shouldHandlePost: skips bot, mods, deleted/removed, flair', () => {
  const o = { botUsername: BOT, skipFlairs: SKIP };
  const reason = (p: PostCandidate) => {
    const d = shouldHandlePost(p, o);
    return d.handle ? 'handled' : d.reason;
  };
  assert.equal(reason(post({ authorName: 'RopeDrop-Bot' })), 'is_bot');
  assert.equal(reason(post({ authorIsMod: true })), 'author_is_mod');
  assert.equal(reason(post({ deleted: true })), 'deleted_or_removed');
  assert.equal(reason(post({ spam: true })), 'deleted_or_removed');
  assert.equal(reason(post({ authorName: '[deleted]' })), 'deleted_or_removed');
  assert.equal(reason(post({ body: '[removed]' })), 'deleted_or_removed');
  assert.equal(reason(post({ flairText: 'trip report' })), 'flair_skipped');
  assert.equal(reason(post({ flairText: ' Photos ' })), 'flair_skipped');
  assert.equal(reason(post({ id: undefined })), 'no_id');
  assert.equal(reason(post({ title: '', body: '' })), 'empty_question');
});

void test('shouldHandlePost: manual (mod menu) bypasses flair + mod-author, not deleted/bot', () => {
  const o = { botUsername: BOT, skipFlairs: SKIP, manual: true };
  assert.deepEqual(shouldHandlePost(post({ flairText: 'Meta' }), o), {
    handle: true,
  });
  assert.deepEqual(shouldHandlePost(post({ authorIsMod: true }), o), {
    handle: true,
  });
  assert.equal(shouldHandlePost(post({ deleted: true }), o).handle, false);
  assert.equal(shouldHandlePost(post({ authorName: BOT }), o).handle, false);
});

void test('isFlairSkipped: exact, case-insensitive; empty flair never skipped', () => {
  assert.equal(isFlairSkipped('META', SKIP), true);
  assert.equal(isFlairSkipped('Metaverse', SKIP), false);
  assert.equal(isFlairSkipped(undefined, SKIP), false);
  assert.equal(isFlairSkipped('', SKIP), false);
});

// ---------------------------------------------------------------- shouldHandleComment

void test('shouldHandleComment: only when the bot is mentioned', () => {
  const o = { botUsername: BOT, skipFlairs: SKIP };
  assert.deepEqual(shouldHandleComment(comment(), o), { handle: true });
  assert.deepEqual(
    shouldHandleComment(comment({ body: 'no mention here' }), o),
    {
      handle: false,
      reason: 'no_mention',
    }
  );
});

void test('shouldHandleComment: skips bot, mods, removed, empty-after-mention', () => {
  const o = { botUsername: BOT, skipFlairs: SKIP };
  const reason = (c: CommentCandidate) => {
    const d = shouldHandleComment(c, o);
    return d.handle ? 'handled' : d.reason;
  };
  assert.equal(reason(comment({ authorName: BOT })), 'is_bot');
  assert.equal(reason(comment({ authorIsMod: true })), 'author_is_mod');
  assert.equal(reason(comment({ spam: true })), 'deleted_or_removed');
  assert.equal(reason(comment({ body: '[deleted]' })), 'deleted_or_removed');
  assert.equal(reason(comment({ body: 'u/ropedrop-bot' })), 'empty_question');
});

void test('shouldHandleComment: manual works without a mention', () => {
  const o = { botUsername: BOT, skipFlairs: SKIP, manual: true };
  assert.deepEqual(
    shouldHandleComment(comment({ body: 'is Tron worth it?' }), o),
    {
      handle: true,
    }
  );
});

void test('meetsConfidence', () => {
  assert.equal(meetsConfidence(0.7, 0.7), true);
  assert.equal(meetsConfidence(0.69, 0.7), false);
  assert.equal(meetsConfidence(Number.NaN, 0.5), false);
});

// ---------------------------------------------------------------- reply body

void test('buildReplyBody: answer, blank line, links (max 3), footer', () => {
  const body = buildReplyBody(
    'Ride **Slinky Dog** at rope drop.',
    [
      {
        title: 'HS crowd calendar',
        url: 'https://ropedropplanner.com/wdw/hollywood_studios',
      },
      { title: 'Slinky waits', url: 'https://ropedropplanner.com/a' },
      { title: 'Rope drop guide', url: 'https://ropedropplanner.com/b' },
      { title: 'Fourth link', url: 'https://ropedropplanner.com/c' },
    ],
    FEEDBACK
  );
  assert.equal(
    body,
    'Ride **Slinky Dog** at rope drop.\n\n' +
      '- [HS crowd calendar](https://ropedropplanner.com/wdw/hollywood_studios)\n' +
      '- [Slinky waits](https://ropedropplanner.com/a)\n' +
      '- [Rope drop guide](https://ropedropplanner.com/b)\n\n' +
      "---\n^(I'm the RopeDrop Planner bot, answering from our wait-time data.) " +
      `[^(Feedback)](${FEEDBACK})`
  );
});

void test('buildReplyBody: no links -> answer then footer', () => {
  const body = buildReplyBody('Short answer.', [], FEEDBACK);
  assert.ok(body.startsWith('Short answer.\n\n---\n^(I'));
});

void test('buildReplyBody: escapes brackets/parens and drops bad links', () => {
  const body = buildReplyBody(
    'A',
    [
      { title: 'Weird [title]', url: 'https://x.com/a_(b)' },
      { title: 'js', url: 'javascript:alert(1)' },
      { title: '', url: 'https://x.com/empty' },
    ],
    FEEDBACK
  );
  assert.ok(body.includes('- [Weird \\[title\\]](https://x.com/a_%28b%29)'));
  assert.ok(!body.includes('javascript'));
  assert.ok(!body.includes('empty'));
});

void test('buildReplyBody: never exceeds Reddit comment limit', () => {
  const body = buildReplyBody('x'.repeat(20000), [], FEEDBACK);
  assert.ok(Array.from(body).length <= MAX_COMMENT_CHARS);
  assert.ok(body.includes('[^(Feedback)]'));
});

// ---------------------------------------------------------------- daily summary

void test('parseDailySummary: title from first "## " line, rest is body', () => {
  const md =
    "## Today's Crowd Outlook — Thursday, Sep 25\n\n| Park | Crowd |\n|---|---|\n| MK | 5/10 |";
  assert.deepEqual(parseDailySummary({ markdown: md, parks: [] }, 'x'), {
    title: "Today's Crowd Outlook — Thursday, Sep 25",
    body: '| Park | Crowd |\n|---|---|\n| MK | 5/10 |',
  });
});

void test('parseDailySummary: no heading -> fallback title with date', () => {
  assert.deepEqual(
    parseDailySummary({ markdown: 'Body only' }, 'Thursday, Sep 25'),
    {
      title: "Today's Crowd Outlook — Thursday, Sep 25",
      body: 'Body only',
    }
  );
});

void test('parseDailySummary: "###" is not a title line', () => {
  const r = parseDailySummary({ markdown: '### Sub\n\ntext' }, 'D');
  assert.equal(r?.title, "Today's Crowd Outlook — D");
});

void test('parseDailySummary: missing/empty markdown -> null', () => {
  assert.equal(parseDailySummary({}, 'D'), null);
  assert.equal(parseDailySummary({ markdown: '   ' }, 'D'), null);
  assert.equal(parseDailySummary(null, 'D'), null);
  assert.equal(parseDailySummary({ markdown: '## Title only' }, 'D'), null);
});

// ---------------------------------------------------------------- cap

void test('capCheck: counts only replies inside the rolling window', () => {
  const now = 10_000_000;
  const hour = 3_600_000;
  const ts = [now - hour - 1, now - hour + 1, now - 5, now];
  assert.deepEqual(capCheck(ts, now, 5, hour), { allowed: true, count: 3 });
  assert.deepEqual(capCheck(ts, now, 3, hour), { allowed: false, count: 3 });
  assert.deepEqual(capCheck([], now, 0, hour), { allowed: false, count: 0 });
});
