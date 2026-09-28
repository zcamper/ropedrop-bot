// Text normalization and phrase matching (bot_parse.normalize, _has_phrase,
// _phrase_spans). Bundle names were normalized with the same rules, so
// comparisons are always normalized-to-normalized.

/**
 * Lowercase; fold curly quotes to '; drop trademark marks and zero-width
 * spaces; '&' -> ' and '; drop apostrophes; every other run of characters
 * outside [a-z0-9] becomes one space.
 */
export function normalize(text: string | null | undefined): string {
  if (!text) return '';
  let t = text.toLowerCase();
  t = t.replace(/[\u2019\u2018`]/g, "'");
  t = t.replace(/[\u2122\u00ae\u00a9\u200b]/g, '');
  t = t.replace(/&/g, ' and ');
  t = t.replace(/'/g, '');
  t = t.replace(/[^a-z0-9]+/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function hasPhrase(norm: string, phrase: string): boolean {
  return ` ${norm} `.includes(` ${phrase} `);
}

/**
 * Non-overlapping [start, end, phrase] hits of `phrases` in `norm`; the
 * longest phrase wins an overlap; returned in text order.
 */
export function phraseSpans(
  norm: string,
  phrases: Iterable<string>
): [number, number, string][] {
  const padded = ` ${norm} `;
  const taken: [number, number, string][] = [];
  // Python: sorted(phrases, key=len, reverse=True) is stable.
  const list = Array.from(phrases)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.length - a.p.length || a.i - b.i)
    .map((x) => x.p);
  for (const ph of list) {
    let start = 0;
    for (;;) {
      const i = padded.indexOf(` ${ph} `, start);
      if (i < 0) break;
      const a = i + 1;
      const b = i + 1 + ph.length;
      if (!taken.some(([ta, tb]) => a < tb && ta < b)) taken.push([a, b, ph]);
      start = i + 1;
    }
  }
  return taken.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}
