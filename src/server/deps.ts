// Production wiring of the engine's dependencies to Devvit's Reddit API,
// Redis and settings, plus the data-bundle refresh (the only HTTP fetch).

import { context, reddit, redis, settings } from '@devvit/web/server';
import { askFromBundle, dailyFromBundle } from '../bot/service.js';
import { openRedisBundle } from '../bundle/source.js';
import { refreshBundle, type KV, type RefreshResult } from '../bundle/sync.js';
import {
  normalizeSettings,
  type BotSettings,
  type RawSettings,
} from '../core/config.js';
import type { Deps, ReplyMarker, Store } from '../core/engine.js';
import { asT1, asT3, isDeletedText } from '../core/logic.js';

const SETTING_KEYS: (keyof BotSettings)[] = [
  'minConfidence',
  'maxRepliesPerHour',
  'skipFlairs',
  'feedbackUrl',
  'dailyPostEnabled',
  'dailyPostHourET',
  'dailyDestination',
  'dailyPostSticky',
  'dryRun',
];

async function loadSettings(): Promise<BotSettings> {
  const values = await Promise.all(SETTING_KEYS.map((k) => settings.get(k)));
  const raw: RawSettings = {};
  SETTING_KEYS.forEach((k, i) => {
    raw[k] = values[i];
  });
  return normalizeSettings(raw);
}

let cachedBotUsername: string | undefined;

async function botUsername(): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const me = await reddit.getAppUser();
    if (me?.username) cachedBotUsername = me.username;
  } catch (err) {
    console.warn(
      `[bot] getAppUser failed, falling back to app slug: ${String(err)}`
    );
  }
  // The app account's username is the app name from devvit.json.
  return cachedBotUsername ?? context.appSlug ?? context.appName;
}

async function isModerator(username: string): Promise<boolean> {
  if (!username || isDeletedText(username)) return false;
  const mods = await reddit
    .getModerators({ subredditName: context.subredditName, username })
    .all();
  return mods.some((m) => m.username.toLowerCase() === username.toLowerCase());
}

async function isStillVisible(thingId: string): Promise<boolean> {
  if (thingId.startsWith('t1_')) {
    const c = await reddit.getCommentById(asT1(thingId));
    return (
      !c.removed &&
      !c.spam &&
      !isDeletedText(c.authorName) &&
      !isDeletedText(c.body)
    );
  }
  const p = await reddit.getPostById(asT3(thingId));
  return (
    !p.removed &&
    !p.spam &&
    !isDeletedText(p.authorName) &&
    !isDeletedText(p.body)
  );
}

const k = {
  replied: (id: string) => `replied:${id}`,
  replies: 'replies:window',
};

const store: Store = {
  async getReplied(id) {
    const v = await redis.get(k.replied(id));
    return v === 'live' || v === 'dry' ? (v as ReplyMarker) : undefined;
  },
  async setReplied(id, marker, ttlSeconds) {
    await redis.set(k.replied(id), marker, {
      expiration: new Date(Date.now() + ttlSeconds * 1000),
    });
  },
  async tryLock(key, ttlSeconds) {
    const r = await redis.set(key, '1', {
      nx: true,
      expiration: new Date(Date.now() + ttlSeconds * 1000),
    });
    return r === 'OK';
  },
  async unlock(key) {
    await redis.del(key);
  },
  async countRecentReplies(nowMs, windowMs) {
    await redis.zRemRangeByScore(k.replies, 0, nowMs - windowMs);
    return redis.zCard(k.replies);
  },
  async recordReply(id, nowMs, windowMs) {
    // Member is the thing id only (no content); whole key expires with the window.
    await redis.zAdd(k.replies, { member: id, score: nowMs });
    await redis.expire(k.replies, Math.ceil((2 * windowMs) / 1000));
  },
};

/** Devvit Redis as the bundle store's key-value surface. */
export const kv: KV = {
  get: (k) => redis.get(k),
  set: (k, v, o) => redis.set(k, v, o),
  del: (...k) => redis.del(...k),
};

const log = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

/** GET the public bundle manifest and store a new generation if there is one. */
export function refreshData(
  opts: { force?: boolean } = {}
): Promise<RefreshResult> {
  return refreshBundle(
    { kv, fetch: (u, i) => fetch(u, i), now: () => new Date(), log },
    opts
  );
}

export const deps: Deps = {
  settings: loadSettings,
  botUsername,
  isModerator,
  isStillVisible,
  ask: async (_s, q) => askFromBundle(await openRedisBundle(kv), new Date(), q),
  dailySummary: async (s) =>
    dailyFromBundle(await openRedisBundle(kv), new Date(), s.dailyDestination),
  async submitComment(parentId, text) {
    const id = parentId.startsWith('t1_') ? asT1(parentId) : asT3(parentId);
    const c = await reddit.submitComment({ id, text, runAs: 'APP' });
    return c.id;
  },
  async submitPost(title, text, sticky) {
    const post = await reddit.submitPost({
      subredditName: context.subredditName,
      title,
      text,
      runAs: 'APP',
    });
    if (sticky) {
      try {
        await post.distinguish();
        await post.sticky(1);
      } catch (err) {
        console.warn(
          `[daily] sticky/distinguish failed for ${post.id}: ${String(err)}`
        );
      }
    }
    return post.id;
  },
  store,
  now: () => new Date(),
  log,
};

/** Is the user who clicked a menu item a moderator here? */
export async function callerIsModerator(): Promise<boolean> {
  const username = context.username ?? (await reddit.getCurrentUsername());
  return username ? isModerator(username) : false;
}

export async function loadPostEvent(postId: string) {
  const p = await reddit.getPostById(asT3(postId));
  return {
    id: p.id,
    title: p.title,
    body: p.body,
    authorName: p.authorName,
    flairText: p.flair?.text,
    deleted: false,
    spam: p.spam || p.removed,
  };
}

export async function loadCommentEvent(commentId: string) {
  const c = await reddit.getCommentById(asT1(commentId));
  return {
    id: c.id,
    body: c.body,
    authorName: c.authorName,
    deleted: false,
    spam: c.spam || c.removed,
  };
}
