// Pure business logic: filtering, question building, reply formatting,
// daily-summary parsing, and the rolling reply cap. No Devvit imports.

import { BOT_DISPLAY_NAME, MAX_LINKS, MAX_QUESTION_CHARS } from './config.js';

// ---------------------------------------------------------------- mentions

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches "u/name" or "/u/name" (case-insensitive) as a whole token, so
 * u/ropedropbot does not match u/ropedropbot2 or xu/ropedropbot.
 */
function mentionRegex(botUsername: string): RegExp {
  return new RegExp(
    `(^|[^A-Za-z0-9_/-])/?u/${escapeRegex(botUsername)}(?![A-Za-z0-9_-])`,
    'gi'
  );
}

export function mentionsBot(
  text: string | undefined,
  botUsername: string
): boolean {
  if (!text || !botUsername) return false;
  return mentionRegex(botUsername).test(text);
}

/** Remove every mention of the bot and tidy whitespace. */
export function stripMention(text: string, botUsername: string): string {
  return text
    .replace(mentionRegex(botUsername), '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- question

/** Truncate by code point so we never split a surrogate pair (emoji). */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** "<title>\n\n<body>", truncated to the backend's 2000-char limit. */
export function buildPostQuestion(
  title: string,
  body: string | undefined
): string {
  const t = (title ?? '').trim();
  const b = (body ?? '').trim();
  return truncate(b ? `${t}\n\n${b}` : t, MAX_QUESTION_CHARS);
}

export function buildCommentQuestion(
  body: string,
  botUsername: string
): string {
  return truncate(stripMention(body ?? '', botUsername), MAX_QUESTION_CHARS);
}

// ---------------------------------------------------------------- filtering

export type SkipReason =
  | 'no_id'
  | 'is_bot'
  | 'deleted_or_removed'
  | 'author_is_mod'
  | 'flair_skipped'
  | 'no_mention'
  | 'empty_question';

export type Decision = { handle: true } | { handle: false; reason: SkipReason };

const DELETED_MARKERS = new Set(['[deleted]', '[removed]']);

export function isDeletedText(text: string | undefined): boolean {
  return DELETED_MARKERS.has((text ?? '').trim().toLowerCase());
}

export function isFlairSkipped(
  flairText: string | undefined,
  skipFlairs: string[]
): boolean {
  const f = (flairText ?? '').trim().toLowerCase();
  if (!f) return false;
  return skipFlairs.some((s) => s.trim().toLowerCase() === f);
}

function sameUser(a: string | undefined, b: string | undefined): boolean {
  return (
    !!a && !!b && a.replace(/^\/?u\//i, '').toLowerCase() === b.toLowerCase()
  );
}

export type PostCandidate = {
  id: string | undefined;
  title: string | undefined;
  body: string | undefined;
  authorName: string | undefined;
  flairText: string | undefined;
  deleted: boolean;
  spam: boolean;
  /** Whether the author moderates the subreddit (resolved by the caller). */
  authorIsMod: boolean;
};

export type CommentCandidate = {
  id: string | undefined;
  body: string | undefined;
  authorName: string | undefined;
  deleted: boolean;
  spam: boolean;
  authorIsMod: boolean;
};

export type FilterOptions = {
  botUsername: string;
  skipFlairs: string[];
  /** Mod menu action: ignore flair skip list and the mod-author rule. */
  manual?: boolean;
};

export function shouldHandlePost(p: PostCandidate, o: FilterOptions): Decision {
  if (!p.id) return { handle: false, reason: 'no_id' };
  if (sameUser(p.authorName, o.botUsername))
    return { handle: false, reason: 'is_bot' };
  if (
    p.deleted ||
    p.spam ||
    isDeletedText(p.authorName) ||
    isDeletedText(p.body) ||
    isDeletedText(p.title)
  ) {
    return { handle: false, reason: 'deleted_or_removed' };
  }
  if (!o.manual && p.authorIsMod)
    return { handle: false, reason: 'author_is_mod' };
  if (!o.manual && isFlairSkipped(p.flairText, o.skipFlairs)) {
    return { handle: false, reason: 'flair_skipped' };
  }
  if (!buildPostQuestion(p.title ?? '', p.body)) {
    return { handle: false, reason: 'empty_question' };
  }
  return { handle: true };
}

export function shouldHandleComment(
  c: CommentCandidate,
  o: FilterOptions
): Decision {
  if (!c.id) return { handle: false, reason: 'no_id' };
  if (sameUser(c.authorName, o.botUsername))
    return { handle: false, reason: 'is_bot' };
  if (
    c.deleted ||
    c.spam ||
    isDeletedText(c.authorName) ||
    isDeletedText(c.body)
  ) {
    return { handle: false, reason: 'deleted_or_removed' };
  }
  // Automatic path: only comments that summon the bot. The mod menu can
  // target any comment.
  if (!o.manual && !mentionsBot(c.body, o.botUsername)) {
    return { handle: false, reason: 'no_mention' };
  }
  if (!o.manual && c.authorIsMod)
    return { handle: false, reason: 'author_is_mod' };
  if (!buildCommentQuestion(c.body ?? '', o.botUsername)) {
    return { handle: false, reason: 'empty_question' };
  }
  return { handle: true };
}

export function meetsConfidence(
  confidence: number,
  threshold: number
): boolean {
  return Number.isFinite(confidence) && confidence >= threshold;
}

// ---------------------------------------------------------------- reply body

export type Link = { title: string; url: string };

/** Reddit comment bodies max out at 10,000 characters. */
export const MAX_COMMENT_CHARS = 10000;

function escapeLinkText(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([[\]\\])/g, '\\$1');
}

function escapeLinkUrl(s: string): string {
  return s
    .trim()
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\s/g, '%20');
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function buildFooter(feedbackUrl: string): string {
  return `---\n^(I'm the ${BOT_DISPLAY_NAME}, answering from our wait-time data.) [^(Feedback)](${escapeLinkUrl(feedbackUrl)})`;
}

/**
 * answer + blank line + up to 3 "- [title](url)" links + "\n\n---\n^(...) [^(Feedback)](url)".
 */
export function buildReplyBody(
  answer: string,
  links: Link[] | undefined,
  feedbackUrl: string
): string {
  const linkLines = (links ?? [])
    .filter(
      (l) =>
        l &&
        typeof l.url === 'string' &&
        isHttpUrl(l.url) &&
        typeof l.title === 'string' &&
        l.title.trim()
    )
    .slice(0, MAX_LINKS)
    .map((l) => `- [${escapeLinkText(l.title)}](${escapeLinkUrl(l.url)})`);

  const tail =
    (linkLines.length ? `\n\n${linkLines.join('\n')}` : '') +
    `\n\n${buildFooter(feedbackUrl)}`;
  const room = MAX_COMMENT_CHARS - Array.from(tail).length;
  let text = (answer ?? '').trim();
  if (Array.from(text).length > room)
    text = `${truncate(text, room - 1).trimEnd()}…`;
  return text + tail;
}

// ---------------------------------------------------------------- daily summary

export const DAILY_TITLE_PREFIX = "Today's Crowd Outlook";
const MAX_TITLE_CHARS = 300;
const MAX_POST_BODY_CHARS = 40000;

/**
 * Split the backend's markdown into a post title (its first "## " line, with
 * the "## " removed) and body (everything else). Returns null when there is
 * nothing to post.
 */
export function parseDailySummary(
  json: unknown,
  dateLabel: string
): { title: string; body: string } | null {
  if (!json || typeof json !== 'object') return null;
  const md = (json as { markdown?: unknown }).markdown;
  if (typeof md !== 'string' || !md.trim()) return null;

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const idx = lines.findIndex((l) => /^##\s+\S/.test(l));
  let title: string;
  let body: string;
  if (idx >= 0) {
    title = (lines[idx] ?? '').replace(/^##\s+/, '').trim();
    body = [...lines.slice(0, idx), ...lines.slice(idx + 1)].join('\n').trim();
  } else {
    title = `${DAILY_TITLE_PREFIX} — ${dateLabel}`;
    body = md.trim();
  }
  if (!body) return null;
  return {
    title: truncate(title, MAX_TITLE_CHARS),
    body: truncate(body, MAX_POST_BODY_CHARS),
  };
}

// ---------------------------------------------------------------- reply cap

/**
 * Rolling-window cap. `timestamps` are epoch-ms of actual replies. Returns
 * whether another reply is allowed and how many fall inside the window.
 */
export function capCheck(
  timestamps: number[],
  nowMs: number,
  maxPerWindow: number,
  windowMs: number
): { allowed: boolean; count: number } {
  const since = nowMs - windowMs;
  const count = timestamps.filter((t) => t > since && t <= nowMs).length;
  return { allowed: count < maxPerWindow, count };
}

// ---------------------------------------------------------------- ids

export function asT3(id: string): `t3_${string}` {
  return (id.startsWith('t3_') ? id : `t3_${id}`) as `t3_${string}`;
}

export function asT1(id: string): `t1_${string}` {
  return (id.startsWith('t1_') ? id : `t1_${id}`) as `t1_${string}`;
}
