// Pure configuration: constants, defaults, and settings normalization.
// No Devvit imports here so everything is unit-testable in plain Node.

/** The only host the app may call. Must match `permissions.http.domains` in devvit.json. */
export const ALLOWED_API_HOST = 'ropedropplanner.com';

/** Shown in the reply footer. Change here if the brand name changes. */
export const BOT_DISPLAY_NAME = 'RopeDrop Planner bot';

/** Max characters of question text sent to /api/bot/ask (backend rejects > 2000). */
export const MAX_QUESTION_CHARS = 2000;

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
  apiBaseUrl: string;
  botKey: string;
  minConfidence: number;
  maxRepliesPerHour: number;
  skipFlairs: string[];
  feedbackUrl: string;
  dailyPostEnabled: boolean;
  dailyPostHourET: number;
  dailyDestination: Destination;
  dailyPostSticky: boolean;
  dryRun: boolean;
};

export const DEFAULTS = {
  apiBaseUrl: 'https://ropedropplanner.com',
  minConfidence: 0.7,
  maxRepliesPerHour: 5,
  skipFlairs: 'Trip Report, Photo, Photos, Meta',
  feedbackUrl:
    'https://www.reddit.com/message/compose?to=/r/ropedropplanner&subject=RopeDrop%20bot%20feedback',
  dailyPostEnabled: true,
  dailyPostHourET: 7,
  dailyDestination: 'wdw' as Destination,
  dailyPostSticky: false,
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
    apiBaseUrl: str(raw.apiBaseUrl, DEFAULTS.apiBaseUrl).replace(/\/+$/, ''),
    botKey: typeof raw.botKey === 'string' ? raw.botKey.trim() : '',
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
    dryRun: bool(raw.dryRun, DEFAULTS.dryRun),
  };
}

/**
 * The bot key is only ever sent to https://ropedropplanner.com. Returns the
 * normalized origin, or null if the configured URL points anywhere else.
 */
export function allowedApiOrigin(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.hostname.toLowerCase() !== ALLOWED_API_HOST) return null;
  if (u.username || u.password) return null;
  return u.origin;
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

export function validateApiBaseUrl(value: unknown): ValidationResult {
  if (typeof value !== 'string' || value.trim() === '') return OK; // empty -> default
  return allowedApiOrigin(value.trim())
    ? OK
    : { success: false, error: `Must be an https URL on ${ALLOWED_API_HOST}.` };
}
