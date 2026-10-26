// Orchestration with every side effect injected (Reddit, Redis, the answer
// engine, clock, logging). Production wiring lives in src/server/deps.ts;
// tests pass fakes.

import {
  CAP_WINDOW_MS,
  DAILY_WINDOW_HOURS,
  DEDUPE_TTL_SECONDS,
  LOCK_TTL_SECONDS,
  MANUAL_CONFIDENCE_FLOOR,
  type BotSettings,
  type Destination,
} from './config.js';
import {
  buildCommentQuestion,
  buildPostQuestion,
  buildReplyBody,
  meetsConfidence,
  mentionsBot,
  parseDailySummary,
  shouldHandleComment,
  shouldHandlePost,
  type Decision,
  type Link,
} from './logic.js';
import type { WeeklyKind } from '../bot/types.js';
import { etDateLabel, etParts, shouldPostDaily } from './time.js';

export type ReplyMarker = 'live' | 'dry';

/** What the in-app answer engine returns for one post/comment. */
export type AskResponse = {
  answer: string;
  confidence: number;
  links: Link[];
  intent: string;
  /** Destination the (main) question was answered for, e.g. "wdw". */
  destination?: string;
  /** Data the answer came from, e.g. "redis:20260928T1750Z" / "embedded:...". */
  source?: string;
};

/** Errors are values (logged, never posted on Reddit). */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Minimal key-value surface the engine needs (backed by Devvit Redis). */
export interface Store {
  getReplied(thingId: string): Promise<ReplyMarker | undefined>;
  setReplied(
    thingId: string,
    marker: ReplyMarker,
    ttlSeconds: number
  ): Promise<void>;
  /** SET NX with expiry. Resolves true if this caller got the lock. */
  tryLock(key: string, ttlSeconds: number): Promise<boolean>;
  unlock(key: string): Promise<void>;
  /** Number of actual replies in the last `windowMs` (prunes older entries). */
  countRecentReplies(nowMs: number, windowMs: number): Promise<number>;
  recordReply(thingId: string, nowMs: number, windowMs: number): Promise<void>;
}

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type Deps = {
  settings: () => Promise<BotSettings>;
  botUsername: () => Promise<string>;
  isModerator: (username: string) => Promise<boolean>;
  /** Re-checks live state right before replying (removed/deleted since the event?). */
  isStillVisible: (thingId: string) => Promise<boolean>;
  /** Answer from the stored data bundle. The text never leaves Reddit. */
  ask: (s: BotSettings, question: string) => Promise<Result<AskResponse>>;
  /** Markdown for "Today's Crowd Outlook" ("## title" line + body). */
  dailySummary: (
    s: BotSettings
  ) => Promise<Result<{ markdown: string; source?: string }>>;
  /** A weekly post from the bundle, built for `dateKey` (ET). */
  weeklyPost: (
    kind: WeeklyKind,
    dest: Destination,
    dateKey: string
  ) => Promise<Result<{ title: string; body: string; source?: string }>>;
  /**
   * Question text of the comment/post a bare summon replied to (post = title + body);
   * undefined when it is gone, removed, or the bot's own comment.
   */
  parentText?: (parentId: string) => Promise<string | undefined>;
  submitComment: (parentId: string, text: string) => Promise<string>;
  submitPost: (title: string, text: string, sticky: boolean) => Promise<string>;
  store: Store;
  now: () => Date;
  log: Logger;
};

export type Outcome =
  | { status: 'replied'; commentId: string; confidence: number }
  | { status: 'dry_run'; confidence: number }
  | { status: 'skipped'; reason: string }
  | { status: 'low_confidence'; confidence: number; threshold: number }
  | { status: 'capped'; count: number; limit?: number }
  | { status: 'duplicate'; reason?: string }
  | { status: 'error'; message: string };

export type Mode = 'auto' | 'manual';

type Target = { thingId: string; question: string };

// ---------------------------------------------------------------- entry points

export type PostEvent = {
  id: string | undefined;
  title: string | undefined;
  body: string | undefined;
  authorName: string | undefined;
  flairText: string | undefined;
  deleted: boolean;
  spam: boolean;
};

export type CommentEvent = {
  id: string | undefined;
  body: string | undefined;
  authorName: string | undefined;
  deleted: boolean;
  spam: boolean;
  parentId?: string | undefined;
};

export type EventKind = 'post' | 'comment' | 'mention';

/** What the log line reports about the answer (never the user's text or name). */
type Trace = {
  intent?: string;
  confidence?: number;
  destination?: string;
  source?: string;
  /** The question came from the comment/post a bare summon replied to. */
  fromParent?: boolean;
};

export async function handlePost(
  deps: Deps,
  ev: PostEvent,
  mode: Mode
): Promise<Outcome> {
  const trace: Trace = {};
  let outcome: Outcome;
  try {
    const [s, bot] = await Promise.all([deps.settings(), deps.botUsername()]);
    const opts = {
      botUsername: bot,
      skipFlairs: s.skipFlairs,
      manual: mode === 'manual',
    };
    const decide = (authorIsMod: boolean): Decision =>
      shouldHandlePost({ ...ev, authorIsMod }, opts);

    let d = decide(false);
    if (d.handle && mode === 'auto' && ev.authorName) {
      d = decide(await deps.isModerator(ev.authorName));
    }
    outcome = !d.handle
      ? { status: 'skipped', reason: d.reason }
      : await respond(deps, s, mode, trace, {
          thingId: ev.id as string,
          question: buildPostQuestion(ev.title ?? '', ev.body),
        });
  } catch (err) {
    outcome = errorOutcome(err);
  }
  deps.log.info(outcomeLine('post', ev.id, mode, outcome, trace));
  return outcome;
}

export async function handleComment(
  deps: Deps,
  ev: CommentEvent,
  mode: Mode
): Promise<Outcome> {
  const trace: Trace = {};
  let kind: EventKind = 'comment';
  let outcome: Outcome;
  try {
    const [s, bot] = await Promise.all([deps.settings(), deps.botUsername()]);
    if (mentionsBot(ev.body, bot)) kind = 'mention';
    const opts = {
      botUsername: bot,
      skipFlairs: s.skipFlairs,
      manual: mode === 'manual',
    };
    const d = shouldHandleComment(ev, opts);
    let question = d.handle ? buildCommentQuestion(ev.body ?? '', bot) : '';
    // A bare summon under a question ("u/bot" as a reply) asks about that question.
    // The reply still goes under the summoning comment.
    if (d.handle && !question && ev.parentId && deps.parentText) {
      question = buildCommentQuestion(
        (await deps.parentText(ev.parentId)) ?? '',
        bot
      );
      if (question) trace.fromParent = true;
    }
    outcome = !d.handle
      ? { status: 'skipped', reason: d.reason }
      : !question
        ? { status: 'skipped', reason: 'empty_question' }
        : await respond(deps, s, mode, trace, {
            thingId: ev.id as string,
            question,
          });
  } catch (err) {
    outcome = errorOutcome(err);
  }
  deps.log.info(outcomeLine(kind, ev.id, mode, outcome, trace));
  return outcome;
}

// ---------------------------------------------------------------- core flow

async function respond(
  deps: Deps,
  s: BotSettings,
  mode: Mode,
  trace: Trace,
  t: Target
): Promise<Outcome> {
  const { store, log } = deps;
  const id = t.thingId;

  // 1. Never reply twice. A dry-run marker blocks the automatic path (so
  //    flipping dryRun off doesn't answer a backlog) but not a mod's request.
  const marker = await store.getReplied(id);
  if (marker === 'live' || (marker === 'dry' && mode === 'auto')) {
    return { status: 'duplicate', reason: `already_handled_${marker}` };
  }

  // 2. Rolling hourly cap on actual replies (mods bypass it).
  const nowMs = deps.now().getTime();
  if (mode === 'auto' && !s.dryRun) {
    const count = await store.countRecentReplies(nowMs, CAP_WINDOW_MS);
    if (count >= s.maxRepliesPerHour) {
      return { status: 'capped', count, limit: s.maxRepliesPerHour };
    }
  }

  // 3. In-flight lock: triggers can be delivered more than once.
  const lockKey = `${mode === 'auto' ? 'lock' : 'mlock'}:${id}`;
  if (!(await store.tryLock(lockKey, LOCK_TTL_SECONDS))) {
    return { status: 'duplicate', reason: 'in_flight' };
  }

  // 4. Still there? (Delivery is async; it may have been removed meanwhile.)
  if (!(await deps.isStillVisible(id))) {
    return { status: 'skipped', reason: 'deleted_or_removed' };
  }

  // 5. Answer from the data bundle (in-process; nothing is sent anywhere).
  const res = await deps.ask(s, t.question);
  if (!res.ok) {
    await store.unlock(lockKey); // let a redelivery / mod retry try again
    return { status: 'error', message: `no data: ${res.error}` };
  }
  const { confidence } = res.data;
  trace.intent = res.data.intent;
  trace.confidence = confidence;
  if (res.data.destination) trace.destination = res.data.destination;
  if (res.data.source) trace.source = res.data.source;
  const threshold =
    mode === 'manual' ? MANUAL_CONFIDENCE_FLOOR : s.minConfidence;
  if (!meetsConfidence(confidence, threshold) || !res.data.answer.trim()) {
    return { status: 'low_confidence', confidence, threshold };
  }

  const body = buildReplyBody(res.data.answer, res.data.links, s.feedbackUrl);

  // 6. Dry run: log instead of posting (the bot's reply, not the user's text).
  if (s.dryRun) {
    log.info(
      `[bot] DRY RUN — would reply to ${id} (confidence ${confidence}):\n${body}`
    );
    await store.setReplied(id, 'dry', DEDUPE_TTL_SECONDS);
    return { status: 'dry_run', confidence };
  }

  // 7. Re-check the marker right before posting (a parallel path may have won).
  if ((await store.getReplied(id)) === 'live')
    return { status: 'duplicate', reason: 'already_handled_live' };

  const commentId = await deps.submitComment(id, body);
  await store.setReplied(id, 'live', DEDUPE_TTL_SECONDS);
  await store.recordReply(id, nowMs, CAP_WINDOW_MS);
  return { status: 'replied', commentId, confidence };
}

function errorOutcome(err: unknown): Outcome {
  return {
    status: 'error',
    message: err instanceof Error ? err.message : String(err),
  };
}

/** Keep log fields on one line and short; they never contain user text. */
function field(v: string): string {
  return v.replace(/\s+/g, '_').slice(0, 200);
}

/**
 * The one log line per handled post / comment / mention:
 *   [bot] post t3_abc mode=auto outcome=dry_run intent=park_hours confidence=0.95 dest=wdw data=embedded:20260928T1750Z
 *   [bot] comment t1_xyz mode=auto outcome=skipped reason=no_mention
 * outcome is replied | dry_run | silent | skipped (+ reason). Contains ids,
 * decisions and data labels only: never the post text or the author's name.
 */
export function outcomeLine(
  kind: EventKind,
  id: string | undefined,
  mode: Mode,
  o: Outcome,
  trace: Trace = {}
): string {
  let outcome: string;
  let reason: string | null = null;
  switch (o.status) {
    case 'replied':
      outcome = 'replied';
      reason = `comment_${o.commentId}`;
      break;
    case 'dry_run':
      outcome = 'dry_run';
      break;
    case 'skipped':
      outcome = 'skipped';
      reason = o.reason;
      break;
    case 'duplicate':
      outcome = 'skipped';
      reason = o.reason ?? 'duplicate';
      break;
    case 'low_confidence':
      outcome = 'silent';
      reason = `low_confidence(${o.confidence}<${o.threshold})`;
      break;
    case 'capped':
      outcome = 'silent';
      reason = `hourly_cap(${o.count}/${o.limit ?? '?'})`;
      break;
    case 'error':
      outcome = 'silent';
      reason = `error:${o.message}`;
      break;
  }
  const parts = [
    `[bot] ${kind} ${id ?? '?'}`,
    `mode=${mode}`,
    `outcome=${outcome}`,
  ];
  if (reason) parts.push(`reason=${field(reason)}`);
  if (trace.intent) parts.push(`intent=${field(trace.intent)}`);
  if (trace.confidence !== undefined)
    parts.push(`confidence=${trace.confidence}`);
  if (trace.destination) parts.push(`dest=${field(trace.destination)}`);
  if (trace.source) parts.push(`data=${field(trace.source)}`);
  if (trace.fromParent) parts.push('question=parent');
  return parts.join(' ');
}

/** Toast text for the mod menu action. Never includes the answer itself. */
export function outcomeToast(o: Outcome): string {
  switch (o.status) {
    case 'replied':
      return `Replied (confidence ${o.confidence.toFixed(2)}).`;
    case 'dry_run':
      return `Dry run: would have replied (confidence ${o.confidence.toFixed(2)}). See app logs.`;
    case 'low_confidence':
      return `Low confidence (${o.confidence.toFixed(2)} < ${o.threshold}); did not reply.`;
    case 'duplicate':
      return 'Already replied to this item.';
    case 'capped':
      return 'Hourly reply cap reached.';
    case 'skipped':
      return `Skipped (${o.reason.replace(/_/g, ' ')}).`;
    case 'error':
      return 'Data unavailable; did not reply. See app logs.';
  }
}

// ---------------------------------------------------------------- daily post

export type DailyOutcome =
  | { status: 'posted'; postId: string; dateKey: string }
  | { status: 'dry_run'; dateKey: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; message: string };

export async function runDaily(deps: Deps): Promise<DailyOutcome> {
  const { store, log } = deps;
  let claimKey: string | undefined;
  try {
    const s = await deps.settings();
    const now = deps.now();
    const probe = shouldPostDaily({
      enabled: s.dailyPostEnabled,
      now,
      targetHourET: s.dailyPostHourET,
      windowHours: DAILY_WINDOW_HOURS,
      alreadyPostedForDate: false,
    });
    if (!probe.post) return { status: 'skipped', reason: probe.reason };

    // "posted-for-date" key doubles as the claim (SET NX) so overlapping
    // ticks can't double-post. Expires after 3 days; holds no content.
    claimKey = `daily:${s.dailyDestination}:${probe.dateKey}`;
    if (!(await store.tryLock(claimKey, 3 * 24 * 60 * 60))) {
      claimKey = undefined;
      return { status: 'skipped', reason: 'already_posted' };
    }

    const res = await deps.dailySummary(s);
    if (!res.ok) throw new Error(`daily-summary failed (${res.error})`);
    const parsed = parseDailySummary(res.data, etDateLabel(now));
    if (!parsed) throw new Error('daily-summary had no markdown');

    const data = res.data.source ? ` (data ${res.data.source})` : '';
    if (s.dryRun) {
      log.info(
        `[daily] DRY RUN — would post "${parsed.title}"${data}:\n${parsed.body}`
      );
      return { status: 'dry_run', dateKey: probe.dateKey };
    }
    const postId = await deps.submitPost(
      parsed.title,
      parsed.body,
      s.dailyPostSticky
    );
    log.info(`[daily] posted ${postId} for ${probe.dateKey}${data}`);
    return { status: 'posted', postId, dateKey: probe.dateKey };
  } catch (err) {
    // Release the claim so the next hourly tick inside the window retries.
    if (claimKey) await store.unlock(claimKey).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[daily] error (${message}); nothing posted`);
    return { status: 'error', message };
  }
}

// ---------------------------------------------------------------- weekly posts

/** Monday: what planners asked (one post). Friday: what changed (one post per resort). */
export const WEEKLY_SCHEDULE: {
  kind: WeeklyKind;
  weekday: number; // ET, 0 = Sunday
  dests: Destination[];
  enabled: (s: BotSettings) => boolean;
}[] = [
  {
    kind: 'weekly_questions',
    weekday: 1,
    dests: ['wdw'], // the questions post is cross-resort; wdw's copy is the one we post
    enabled: (s) => s.weeklyQuestionsEnabled,
  },
  {
    kind: 'weekly_changes',
    weekday: 5,
    dests: ['wdw', 'dlr'],
    enabled: (s) => s.weeklyChangesEnabled,
  },
];

export type WeeklyOutcome = {
  kind: WeeklyKind;
  dest: Destination;
} & DailyOutcome;

/** Hourly tick: post whichever weekly post is due (same window/claim rules as the daily post). */
export async function runWeekly(deps: Deps): Promise<WeeklyOutcome[]> {
  const { store, log } = deps;
  const out: WeeklyOutcome[] = [];
  let s: BotSettings;
  try {
    s = await deps.settings();
  } catch (err) {
    log.error(`[weekly] settings error (${String(err)}); nothing posted`);
    return out;
  }
  const now = deps.now();
  const et = etParts(now);
  for (const job of WEEKLY_SCHEDULE) {
    for (const dest of job.dests) {
      const tag = { kind: job.kind, dest };
      if (et.weekday !== job.weekday) continue;
      const probe = shouldPostDaily({
        enabled: job.enabled(s),
        now,
        targetHourET: s.weeklyPostHourET,
        windowHours: DAILY_WINDOW_HOURS,
        alreadyPostedForDate: false,
      });
      if (!probe.post) {
        out.push({ ...tag, status: 'skipped', reason: probe.reason });
        continue;
      }
      const claimKey = `weekly:${job.kind}:${dest}:${probe.dateKey}`;
      if (!(await store.tryLock(claimKey, 8 * 24 * 60 * 60))) {
        out.push({ ...tag, status: 'skipped', reason: 'already_posted' });
        continue;
      }
      try {
        const res = await deps.weeklyPost(job.kind, dest, probe.dateKey);
        if (!res.ok) {
          if (res.error.startsWith('nothing_to_post')) {
            // Keep the claim: the data for today says there's nothing to post.
            log.info(`[weekly] ${job.kind} ${dest}: ${res.error}`);
            out.push({ ...tag, status: 'skipped', reason: 'nothing_to_post' });
            continue;
          }
          throw new Error(res.error);
        }
        const data = res.data.source ? ` (data ${res.data.source})` : '';
        if (s.dryRun) {
          log.info(
            `[weekly] DRY RUN — would post "${res.data.title}"${data}:\n${res.data.body}`
          );
          out.push({ ...tag, status: 'dry_run', dateKey: probe.dateKey });
          continue;
        }
        const postId = await deps.submitPost(res.data.title, res.data.body, false);
        log.info(`[weekly] posted ${postId} ${job.kind} ${dest} for ${probe.dateKey}${data}`);
        out.push({ ...tag, status: 'posted', postId, dateKey: probe.dateKey });
      } catch (err) {
        await store.unlock(claimKey).catch(() => undefined);
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[weekly] ${job.kind} ${dest} error (${message}); nothing posted`);
        out.push({ ...tag, status: 'error', message });
      }
    }
  }
  return out;
}
