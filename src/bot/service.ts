// Glue between a stored bundle generation and the engine: answer a post or
// comment, or render the daily outlook. Pure (no Devvit imports) so tests can
// run it against the frozen bundle snapshot.

import { MAX_BUNDLE_AGE_MS, MAX_QUESTION_CHARS } from '../core/config.js';
import type { AskResponse, Result } from '../core/engine.js';
import { truncate } from '../core/logic.js';
import { analyzePost } from './answer.js';
import { renderDailyMarkdown } from './summary.js';
import { localToday } from './tz.js';
import type { BundleSource, Dest } from './types.js';
import { isoDay } from './util.js';

export type StoredBundle = BundleSource & { generatedAt(): string };

function tooOld(src: StoredBundle, now: Date): string | null {
  const t = Date.parse(src.generatedAt());
  if (!Number.isFinite(t)) return 'bundle has no generated_at';
  const age = now.getTime() - t;
  return age > MAX_BUNDLE_AGE_MS
    ? `bundle is stale (${Math.round(age / 3_600_000)} h old)`
    : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function askFromBundle(
  src: StoredBundle | null,
  now: Date,
  question: string
): Promise<Result<AskResponse>> {
  if (!src) return { ok: false, error: 'bundle not loaded yet' };
  const stale = tooOld(src, now);
  if (stale) return { ok: false, error: stale };
  try {
    const common = await src.common();
    const r = await analyzePost(
      { src, common, now },
      truncate(question, MAX_QUESTION_CHARS)
    );
    const confidence = r.intent === 'no_question' ? 0 : r.confidence;
    const dest = r.parts[0]?.pq.destination;
    return {
      ok: true,
      data: {
        answer: r.answer,
        confidence,
        links: r.links,
        intent: r.intent,
        ...(dest ? { destination: dest } : {}),
      },
    };
  } catch (err) {
    return { ok: false, error: `answer failed: ${message(err)}` };
  }
}

export async function dailyFromBundle(
  src: StoredBundle | null,
  now: Date,
  dest: Dest
): Promise<Result<{ markdown: string }>> {
  if (!src) return { ok: false, error: 'bundle not loaded yet' };
  const stale = tooOld(src, now);
  if (stale) return { ok: false, error: stale };
  try {
    const [common, core] = await Promise.all([src.common(), src.core(dest)]);
    if (!core) return { ok: false, error: `no ${dest} data in the bundle` };
    // "Today's" outlook only from data built today (park-local): an older
    // snapshot's hours and forecast are never presented as today's.
    const today = localToday(dest, now);
    if (core.local_date < isoDay(today)) {
      return {
        ok: false,
        error: `data is from ${core.local_date}, older than today (${isoDay(today)})`,
      };
    }
    const md = renderDailyMarkdown(common, core, dest, today);
    return md
      ? { ok: true, data: { markdown: md } }
      : { ok: false, error: 'no outlook data for today' };
  } catch (err) {
    return { ok: false, error: `outlook failed: ${message(err)}` };
  }
}

/** A bundle generation to answer from, labelled for logs ("redis:<gen>"). */
export type LabelledBundle = { src: StoredBundle; label: string };

/**
 * Answer from the first source that works (callers pass them newest first).
 * The result names the source it came from.
 */
export async function askFromSources(
  sources: LabelledBundle[],
  now: Date,
  question: string
): Promise<Result<AskResponse>> {
  if (!sources.length) return { ok: false, error: 'bundle not loaded yet' };
  const errors: string[] = [];
  for (const s of sources) {
    const r = await askFromBundle(s.src, now, question);
    if (r.ok) return { ok: true, data: { ...r.data, source: s.label } };
    errors.push(`${s.label}: ${r.error}`);
  }
  return { ok: false, error: errors.join('; ') };
}

export async function dailyFromSources(
  sources: LabelledBundle[],
  now: Date,
  dest: Dest
): Promise<Result<{ markdown: string; source?: string }>> {
  if (!sources.length) return { ok: false, error: 'bundle not loaded yet' };
  const errors: string[] = [];
  for (const s of sources) {
    const r = await dailyFromBundle(s.src, now, dest);
    if (r.ok) return { ok: true, data: { ...r.data, source: s.label } };
    errors.push(`${s.label}: ${r.error}`);
  }
  return { ok: false, error: errors.join('; ') };
}
