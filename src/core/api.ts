// Client for the RopeDrop backend (/api/bot/*). `fetch` is injected so tests
// run without network. Errors are returned as values, never thrown, so
// callers can log-and-skip (we never post an error message on Reddit).

import { allowedApiOrigin, MAX_QUESTION_CHARS } from './config.js';
import { truncate, type Link } from './logic.js';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type AskResponse = {
  answer: string;
  confidence: number;
  links: Link[];
  intent: string;
};

export type ApiError =
  | { kind: 'config'; message: string }
  | { kind: 'http'; status: number }
  | { kind: 'network'; message: string }
  | { kind: 'bad_response'; message: string };

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; error: ApiError };

export type ApiConfig = { apiBaseUrl: string; botKey: string };

/** Devvit's HTTP fetch hard limit is 30 s; stay under it. */
const TIMEOUT_MS = 25_000;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function describeApiError(e: ApiError): string {
  switch (e.kind) {
    case 'http':
      return `HTTP ${e.status}`;
    default:
      return `${e.kind}: ${e.message}`;
  }
}

function checkConfig(cfg: ApiConfig): ApiResult<string> {
  const origin = allowedApiOrigin(cfg.apiBaseUrl);
  if (!origin) {
    return {
      ok: false,
      error: {
        kind: 'config',
        message: 'apiBaseUrl is not an allowed https URL',
      },
    };
  }
  if (!cfg.botKey) {
    return {
      ok: false,
      error: { kind: 'config', message: 'botKey secret is not set' },
    };
  }
  return { ok: true, data: origin };
}

export function parseAskResponse(json: unknown): AskResponse | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  if (typeof j.answer !== 'string') return null;
  const conf =
    typeof j.confidence === 'number' ? j.confidence : Number(j.confidence);
  if (!Number.isFinite(conf)) return null;
  const links: Link[] = Array.isArray(j.links)
    ? j.links
        .filter(
          (l): l is Link =>
            !!l &&
            typeof l === 'object' &&
            typeof (l as Link).title === 'string' &&
            typeof (l as Link).url === 'string'
        )
        .map((l) => ({ title: l.title, url: l.url }))
    : [];
  const intent = typeof j.intent === 'string' ? j.intent : '';
  // Contract: intent "no_question" means confidence 0 no matter what.
  const confidence =
    intent === 'no_question' ? 0 : Math.min(1, Math.max(0, conf));
  return { answer: j.answer, confidence, links, intent };
}

async function request(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit
): Promise<ApiResult<unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const rsp = await fetchFn(url, { ...init, signal: ctrl.signal });
    if (!rsp.ok)
      return { ok: false, error: { kind: 'http', status: rsp.status } };
    try {
      return { ok: true, data: await rsp.json() };
    } catch (err) {
      return {
        ok: false,
        error: { kind: 'bad_response', message: describeError(err) },
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: { kind: 'network', message: describeError(err) },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function askBot(
  fetchFn: FetchFn,
  cfg: ApiConfig,
  question: string
): Promise<ApiResult<AskResponse>> {
  const origin = checkConfig(cfg);
  if (!origin.ok) return origin;
  const res = await request(fetchFn, `${origin.data}/api/bot/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bot-Key': cfg.botKey },
    body: JSON.stringify({ question: truncate(question, MAX_QUESTION_CHARS) }),
  });
  if (!res.ok) return res;
  const parsed = parseAskResponse(res.data);
  return parsed
    ? { ok: true, data: parsed }
    : {
        ok: false,
        error: { kind: 'bad_response', message: 'unexpected /ask shape' },
      };
}

export async function getDailySummary(
  fetchFn: FetchFn,
  cfg: ApiConfig,
  destination: string
): Promise<ApiResult<unknown>> {
  const origin = checkConfig(cfg);
  if (!origin.ok) return origin;
  return request(
    fetchFn,
    `${origin.data}/api/bot/daily-summary?destination=${encodeURIComponent(destination)}`,
    { method: 'GET', headers: { 'X-Bot-Key': cfg.botKey } }
  );
}
