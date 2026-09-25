// Orchestration with every side effect injected (Reddit, Redis, HTTP, clock,
// logging). Production wiring lives in src/server/deps.ts; tests pass fakes.

import {
  CAP_WINDOW_MS,
  DAILY_WINDOW_HOURS,
  DEDUPE_TTL_SECONDS,
  LOCK_TTL_SECONDS,
  MANUAL_CONFIDENCE_FLOOR,
  type BotSettings,
} from './config.js';
import { describeApiError, type ApiResult, type AskResponse } from './api.js';
import {
  buildCommentQuestion,
  buildPostQuestion,
  buildReplyBody,
  meetsConfidence,
  parseDailySummary,
  shouldHandleComment,
  shouldHandlePost,
  type Decision,
} from './logic.js';
import { etDateLabel, shouldPostDaily } from './time.js';

export type ReplyMarker = 'live' | 'dry';

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
  ask: (s: BotSettings, question: string) => Promise<ApiResult<AskResponse>>;
  dailySummary: (s: BotSettings) => Promise<ApiResult<unknown>>;
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
  | { status: 'capped'; count: number }
  | { status: 'duplicate' }
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
};

export async function handlePost(
  deps: Deps,
  ev: PostEvent,
  mode: Mode
): Promise<Outcome> {
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
    if (!d.handle) return skip(deps, ev.id, d.reason);

    return await respond(deps, s, mode, {
      thingId: ev.id as string,
      question: buildPostQuestion(ev.title ?? '', ev.body),
    });
  } catch (err) {
    return fail(deps, ev.id, err);
  }
}

export async function handleComment(
  deps: Deps,
  ev: CommentEvent,
  mode: Mode
): Promise<Outcome> {
  try {
    const [s, bot] = await Promise.all([deps.settings(), deps.botUsername()]);
    const opts = {
      botUsername: bot,
      skipFlairs: s.skipFlairs,
      manual: mode === 'manual',
    };
    const decide = (authorIsMod: boolean): Decision =>
      shouldHandleComment({ ...ev, authorIsMod }, opts);

    let d = decide(false);
    if (d.handle && mode === 'auto' && ev.authorName) {
      d = decide(await deps.isModerator(ev.authorName));
    }
    if (!d.handle) return skip(deps, ev.id, d.reason);

    return await respond(deps, s, mode, {
      thingId: ev.id as string,
      question: buildCommentQuestion(ev.body ?? '', bot),
    });
  } catch (err) {
    return fail(deps, ev.id, err);
  }
}

// ---------------------------------------------------------------- core flow

async function respond(
  deps: Deps,
  s: BotSettings,
  mode: Mode,
  t: Target
): Promise<Outcome> {
  const { store, log } = deps;
  const id = t.thingId;

  // 1. Never reply twice. A dry-run marker blocks the automatic path (so
  //    flipping dryRun off doesn't answer a backlog) but not a mod's request.
  const marker = await store.getReplied(id);
  if (marker === 'live' || (marker === 'dry' && mode === 'auto')) {
    log.info(`[bot] ${id}: already handled (${marker})`);
    return { status: 'duplicate' };
  }

  // 2. Rolling hourly cap on actual replies (mods bypass it).
  const nowMs = deps.now().getTime();
  if (mode === 'auto' && !s.dryRun) {
    const count = await store.countRecentReplies(nowMs, CAP_WINDOW_MS);
    if (count >= s.maxRepliesPerHour) {
      log.info(
        `[bot] ${id}: hourly cap reached (${count}/${s.maxRepliesPerHour})`
      );
      return { status: 'capped', count };
    }
  }

  // 3. In-flight lock: triggers can be delivered more than once.
  const lockKey = `${mode === 'auto' ? 'lock' : 'mlock'}:${id}`;
  if (!(await store.tryLock(lockKey, LOCK_TTL_SECONDS))) {
    log.info(`[bot] ${id}: in flight elsewhere`);
    return { status: 'duplicate' };
  }

  // 4. Still there? (Delivery is async; it may have been removed meanwhile.)
  if (!(await deps.isStillVisible(id))) {
    return skip(deps, id, 'deleted_or_removed');
  }

  // 5. Ask the backend.
  const res = await deps.ask(s, t.question);
  if (!res.ok) {
    await store.unlock(lockKey); // let a redelivery / mod retry try again
    log.warn(
      `[bot] ${id}: /api/bot/ask failed (${describeApiError(res.error)}); not replying`
    );
    return { status: 'error', message: describeApiError(res.error) };
  }
  const { confidence } = res.data;
  const threshold =
    mode === 'manual' ? MANUAL_CONFIDENCE_FLOOR : s.minConfidence;
  if (!meetsConfidence(confidence, threshold) || !res.data.answer.trim()) {
    log.info(
      `[bot] ${id}: confidence ${confidence} < ${threshold} (intent=${res.data.intent}); staying quiet`
    );
    return { status: 'low_confidence', confidence, threshold };
  }

  const body = buildReplyBody(res.data.answer, res.data.links, s.feedbackUrl);

  // 6. Dry run: log instead of posting.
  if (s.dryRun) {
    log.info(
      `[bot] DRY RUN — would reply to ${id} (confidence ${confidence}):\n${body}`
    );
    await store.setReplied(id, 'dry', DEDUPE_TTL_SECONDS);
    return { status: 'dry_run', confidence };
  }

  // 7. Re-check the marker right before posting (a parallel path may have won).
  if ((await store.getReplied(id)) === 'live') return { status: 'duplicate' };

  const commentId = await deps.submitComment(id, body);
  await store.setReplied(id, 'live', DEDUPE_TTL_SECONDS);
  await store.recordReply(id, nowMs, CAP_WINDOW_MS);
  log.info(
    `[bot] replied to ${id} with ${commentId} (confidence ${confidence}, mode ${mode})`
  );
  return { status: 'replied', commentId, confidence };
}

function skip(deps: Deps, id: string | undefined, reason: string): Outcome {
  deps.log.info(`[bot] ${id ?? '?'}: skipped (${reason})`);
  return { status: 'skipped', reason };
}

function fail(deps: Deps, id: string | undefined, err: unknown): Outcome {
  const message = err instanceof Error ? err.message : String(err);
  deps.log.error(`[bot] ${id ?? '?'}: error (${message}); not replying`);
  return { status: 'error', message };
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
      return 'Error reaching RopeDrop; did not reply. See app logs.';
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
    if (!res.ok)
      throw new Error(`daily-summary failed (${describeApiError(res.error)})`);
    const parsed = parseDailySummary(res.data, etDateLabel(now));
    if (!parsed) throw new Error('daily-summary had no markdown');

    if (s.dryRun) {
      log.info(
        `[daily] DRY RUN — would post "${parsed.title}":\n${parsed.body}`
      );
      return { status: 'dry_run', dateKey: probe.dateKey };
    }
    const postId = await deps.submitPost(
      parsed.title,
      parsed.body,
      s.dailyPostSticky
    );
    log.info(`[daily] posted ${postId} for ${probe.dateKey}`);
    return { status: 'posted', postId, dateKey: probe.dateKey };
  } catch (err) {
    // Release the claim so the next hourly tick inside the window retries.
    if (claimKey) await store.unlock(claimKey).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[daily] error (${message}); nothing posted`);
    return { status: 'error', message };
  }
}
