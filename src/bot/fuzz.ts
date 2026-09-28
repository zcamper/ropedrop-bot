// rapidfuzz fuzz.ratio / fuzz.partial_ratio (normalized Indel similarity,
// 0-100), ported from rapidfuzz 3.x fuzz_py.py so fuzzy ride/restaurant
// matching scores exactly like the Python backend.

/** Longest common subsequence length (bit-parallel for short `a`). */
function lcsLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  if (a.length <= 30) {
    const pm = new Map<number, number>();
    for (let i = 0; i < a.length; i++) {
      const c = a.charCodeAt(i);
      pm.set(c, (pm.get(c) ?? 0) | (1 << i));
    }
    const mask = (1 << a.length) - 1;
    let v = mask;
    for (let j = 0; j < b.length; j++) {
      const u = v & (pm.get(b.charCodeAt(j)) ?? 0);
      v = ((v + u) | (v - u)) & mask;
    }
    let zeros = 0;
    for (let i = 0; i < a.length; i++) if (!(v & (1 << i))) zeros++;
    return zeros;
  }
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] =
        ca === b.charCodeAt(j - 1)
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] as number;
}

/** Normalized Indel similarity in [0, 1]. */
function indelSimilarity(a: string, b: string): number {
  const max = a.length + b.length;
  if (!max) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const dist = max - 2 * lcsLength(s, l);
  return 1.0 - dist / max;
}

export function ratio(s1: string, s2: string): number {
  return indelSimilarity(s1, s2) * 100;
}

/** rapidfuzz _partial_ratio_impl; assumes s1.length <= s2.length. */
function partialImpl(s1: string, s2: string): number {
  const set = new Set(s1);
  const len1 = s1.length;
  const len2 = s2.length;
  let score = 0;
  for (let i = 1; i < len1; i++) {
    if (!set.has(s2[i - 1] as string)) continue;
    const r = indelSimilarity(s1, s2.slice(0, i));
    if (r > score) {
      score = r;
      if (score === 1) return 100;
    }
  }
  for (let i = 0; i < len2 - len1; i++) {
    if (!set.has(s2[i + len1 - 1] as string)) continue;
    const r = indelSimilarity(s1, s2.slice(i, i + len1));
    if (r > score) {
      score = r;
      if (score === 1) return 100;
    }
  }
  for (let i = Math.max(0, len2 - len1); i < len2; i++) {
    if (!set.has(s2[i] as string)) continue;
    const r = indelSimilarity(s1, s2.slice(i));
    if (r > score) {
      score = r;
      if (score === 1) return 100;
    }
  }
  return score * 100;
}

export function partialRatio(s1: string, s2: string): number {
  if (!s1 && !s2) return 100;
  const [shorter, longer] = s1.length <= s2.length ? [s1, s2] : [s2, s1];
  let res = partialImpl(shorter, longer);
  if (res !== 100 && s1.length === s2.length) {
    const r2 = partialImpl(longer, shorter);
    if (r2 > res) res = r2;
  }
  return res;
}
