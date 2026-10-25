// Pure configuration: constants, defaults, and settings normalization.
// No Devvit imports here so everything is unit-testable in plain Node.

/** Shown in the reply footer. Change here if the brand name changes. */
export const BOT_DISPLAY_NAME = 'RopeDrop Planner bot';

/** Max characters of post text the parser looks at (same limit the old API had). */
export const MAX_QUESTION_CHARS = 2000;

/**
 * Don't answer from a bundle older than this. 30 days = the published-hours
 * window, so the snapshot embedded at upload time keeps working while the
 * daily refresh is unavailable. Date-bound answers are further limited to
 * the dates the data covers (hours 30 d, crowds 183 d, events 14 d from the
 * data's own date); closures need data from the last 2 days.
 */
export const MAX_BUNDLE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Closures ("no operating status in the last ~24 hours") need data at most this old. */
export const MAX_CLOSURES_AGE_MS = 48 * 60 * 60 * 1000;

/** Hard confidence floor for the mod "Ask RopeDrop bot" menu action. */
export const MANUAL_CONFIDENCE_FLOOR = 0.5;

/** Max links rendered under an answer. */
export const MAX_LINKS = 3;

/** Dedupe marker lifetime: ids only, never content. */
export const DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** In-flight lock so duplicate trigger deliveries don't double-ask. */
export const LOCK_TTL_SECONDS = 10 * 60;

/** Rolling window for the reply cap. */
export const CAP_WINDOW_MS = 60 * 60 * 1000;

/** How many hours after dailyPostHourET the daily post may still go out (missed ticks). */
export const DAILY_WINDOW_HOURS = 3;

export type Destination = 'wdw' | 'dlr';

export type BotSettings = {
  minConfidence: number;
  maxRepliesPerHour: number;
  skipFlairs: string[];
  feedbackUrl: string;
  dailyPostEnabled: boolean;
  dailyPostHourET: number;
  dailyDestination: Destination;
  dailyPostSticky: boolean;
  weeklyQuestionsEnabled: boolean;
  weeklyChangesEnabled: boolean;
  weeklyPostHourET: number;
  dryRun: boolean;
};

export const DEFAULTS = {
  minConfidence: 0.7,
  maxRepliesPerHour: 5,
  skipFlairs: 'Trip Report, Photo, Photos, Meta',
  feedbackUrl:
    'https://www.reddit.com/message/compose?to=/r/ropedropplanner&subject=RopeDrop%20bot%20feedback',
  dailyPostEnabled: true,
  dailyPostHourET: 7,
  dailyDestination: 'wdw' as Destination,
  dailyPostSticky: false,
  // Weekly posts (2026-10-24) start OFF: a mod turns them on after reviewing a sample.
  weeklyQuestionsEnabled: false,
  weeklyChangesEnabled: false,
  weeklyPostHourET: 9,
  // Safe by default: a fresh install logs what it would post instead of posting.
  dryRun: true,
} as const;

/** Raw values as returned by settings.get (any may be undefined or mistyped). */
export type RawSettings = Partial<Record<keyof BotSettings, unknown>>;

export function parseSkipFlairs(raw: unknown): string[] {
  if (Array.isArray(raw)) raw = raw.join(',');
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]+/)) {
    const v = part.trim();
    const key = v.toLowerCase();
    if (v && !seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

function num(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function bool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function str(raw: unknown, fallback: string): string {
  if (Array.isArray(raw)) raw = raw[0];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Normalize raw settings into a fully-populated, clamped BotSettings. */
export function normalizeSettings(raw: RawSettings): BotSettings {
  const dest = str(
    raw.dailyDestination,
    DEFAULTS.dailyDestination
  ).toLowerCase();
  return {
    minConfidence: clamp(num(raw.minConfidence, DEFAULTS.minConfidence), 0, 1),
    maxRepliesPerHour: Math.floor(
      clamp(num(raw.maxRepliesPerHour, DEFAULTS.maxRepliesPerHour), 0, 60)
    ),
    skipFlairs:
      raw.skipFlairs === undefined
        ? parseSkipFlairs(DEFAULTS.skipFlairs)
        : parseSkipFlairs(raw.skipFlairs),
    feedbackUrl: str(raw.feedbackUrl, DEFAULTS.feedbackUrl),
    dailyPostEnabled: bool(raw.dailyPostEnabled, DEFAULTS.dailyPostEnabled),
    dailyPostHourET: Math.floor(
      clamp(num(raw.dailyPostHourET, DEFAULTS.dailyPostHourET), 0, 23)
    ),
    dailyDestination: dest === 'dlr' ? 'dlr' : 'wdw',
    dailyPostSticky: bool(raw.dailyPostSticky, DEFAULTS.dailyPostSticky),
    weeklyQuestionsEnabled: bool(
      raw.weeklyQuestionsEnabled,
      DEFAULTS.weeklyQuestionsEnabled
    ),
    weeklyChangesEnabled: bool(
      raw.weeklyChangesEnabled,
      DEFAULTS.weeklyChangesEnabled
    ),
    weeklyPostHourET: Math.floor(
      clamp(num(raw.weeklyPostHourET, DEFAULTS.weeklyPostHourET), 0, 23)
    ),
    dryRun: bool(raw.dryRun, DEFAULTS.dryRun),
  };
}

// ---- Settings validators (wired to devvit.json validationEndpoint) ----

export type ValidationResult =
  { success: true } | { success: false; error: string };

const OK: ValidationResult = { success: true };

export function validateMinConfidence(value: unknown): ValidationResult {
  const n = num(value, NaN);
  if (!Number.isFinite(n) || n < MANUAL_CONFIDENCE_FLOOR || n > 1) {
    return {
      success: false,
      error: `Must be a number between ${MANUAL_CONFIDENCE_FLOOR} and 1.`,
    };
  }
  return OK;
}

export function validateMaxRepliesPerHour(value: unknown): ValidationResult {
  const n = num(value, NaN);
  if (!Number.isInteger(n) || n < 0 || n > 60) {
    return { success: false, error: 'Must be a whole number from 0 to 60.' };
  }
  return OK;
}

export function validateHourET(value: unknown): ValidationResult {
  const n = num(value, NaN);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    return {
      success: false,
      error: 'Must be a whole hour from 0 to 23 (Eastern Time).',
    };
  }
  return OK;
}

export function validateHttpsUrl(value: unknown): ValidationResult {
  if (typeof value !== 'string' || value.trim() === '') return OK; // empty -> default
  try {
    const u = new URL(value.trim());
    if (u.protocol === 'https:') return OK;
  } catch {
    // fall through
  }
  return { success: false, error: 'Must be a full https:// URL.' };
}
