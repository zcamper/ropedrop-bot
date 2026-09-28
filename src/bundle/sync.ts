// Nightly bundle refresh: GET the public manifest, download each file of a
// new generation, verify byte count + sha256, store it in Redis, then flip a
// single "current generation" key. Readers only ever follow that pointer, so
// they never see a half-written generation. The previous generation is kept
// until the next one is complete (and is the fallback if reading fails).
//
// Every request is a GET to the one allow-listed host. Nothing about Reddit
// users or posts is sent.

import type { Manifest } from '../bot/types.js';
import { sha256Hex } from './sha256.js';

export const BUNDLE_HOST = 'ropedrop-bot-data.storage.googleapis.com';
export const MANIFEST_URL = `https://${BUNDLE_HOST}/bundle/v1/manifest.json`;
export const SCHEMA = 'ropedrop-bot-bundle';
export const SCHEMA_VERSION = 1;

/** Redis key layout (one namespace per schema version). */
export const K = {
  current: 'bundle:v1:current',
  previous: 'bundle:v1:previous',
  gens: 'bundle:v1:gens',
  lock: 'bundle:v1:lock',
  status: 'bundle:v1:status',
  meta: (gen: string) => `bundle:v1:gen:${gen}`,
  blob: (sha: string) => `bundle:v1:blob:${sha}`,
  chunk: (sha: string, i: number) => `bundle:v1:blob:${sha}:${i}`,
};

/** Max characters per Redis value: <= 3 bytes/char in UTF-8 keeps every value under ~3 MB (< 4 MB). */
export const CHUNK_CHARS = 1_000_000;
/** Devvit's fetch limit is 30 s. */
export const FETCH_TIMEOUT_MS = 25_000;
export const LOCK_TTL_S = 10 * 60;

export interface KV {
  get(key: string): Promise<string | undefined | null>;
  set(
    key: string,
    value: string,
    opts?: { nx?: boolean; expiration?: Date }
  ): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type FileMeta = {
  sha256: string;
  bytes: number;
  chars: number;
  chunks: number;
  kind: string;
  dest: string | null;
};

export type GenMeta = {
  generation: string;
  generated_at: string;
  stored_at: string;
  complete: boolean;
  common: string;
  destinations: Manifest['destinations'];
  files: Record<string, FileMeta>;
  total_bytes: number;
};

export type RefreshResult =
  | { status: 'unchanged'; generation: string }
  | {
      status: 'updated';
      generation: string;
      previous: string | null;
      bytes: number;
      chunks: number;
      downloaded: number;
    }
  | { status: 'locked' }
  | { status: 'error'; message: string };

export type SyncDeps = {
  kv: KV;
  fetch: FetchFn;
  now: () => Date;
  log: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
};

async function getBytes(fetchFn: FetchFn, url: string): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const rsp = await fetchFn(url, { method: 'GET', signal: ctrl.signal });
    if (!rsp.ok) throw new Error(`HTTP ${rsp.status} for ${url}`);
    return new Uint8Array(await rsp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function safePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    /^[A-Za-z0-9_./-]+$/.test(p) &&
    !p.includes('..') &&
    !p.startsWith('/')
  );
}

/** Validate a manifest; throws with a reason. Only the allow-listed host is ever used. */
export function checkManifest(m: unknown): Manifest {
  const x = m as Manifest;
  if (!x || typeof x !== 'object') throw new Error('manifest is not an object');
  if (x.schema !== SCHEMA || x.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported schema ${String(x.schema)} v${String(x.schema_version)}`
    );
  }
  if (
    typeof x.generation !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(x.generation)
  ) {
    throw new Error('bad generation');
  }
  if (
    typeof x.base_url !== 'string' ||
    !x.base_url.startsWith(`https://${BUNDLE_HOST}/`)
  ) {
    throw new Error('base_url is not on the allow-listed host');
  }
  if (!Array.isArray(x.files) || !x.files.length)
    throw new Error('manifest has no files');
  for (const f of x.files) {
    if (
      !safePath(f.path) ||
      !/^[0-9a-f]{64}$/.test(f.sha256) ||
      !(f.bytes > 0)
    ) {
      throw new Error(`bad file entry ${String(f?.path)}`);
    }
  }
  if (!safePath(x.common) || !x.files.some((f) => f.path === x.common))
    throw new Error('bad common path');
  return x;
}

/** Split into Redis-sized pieces without cutting a surrogate pair. */
export function splitChunks(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    out.push(text.slice(i, end));
    i = end;
  }
  return out.length ? out : [''];
}

async function readJson<T>(kv: KV, key: string): Promise<T | null> {
  const v = await kv.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

/** Is this blob fully stored (its commit marker is written last)? */
async function hasBlob(kv: KV, sha: string, chunks: number): Promise<boolean> {
  return (await kv.get(K.blob(sha))) === String(chunks);
}

async function storeFile(
  deps: SyncDeps,
  base: string,
  f: Manifest['files'][number]
): Promise<FileMeta> {
  const bytes = await getBytes(deps.fetch, base + f.path);
  if (bytes.byteLength !== f.bytes)
    throw new Error(
      `${f.path}: ${bytes.byteLength} bytes, manifest says ${f.bytes}`
    );
  const sha = await sha256Hex(bytes);
  if (sha !== f.sha256) throw new Error(`${f.path}: sha256 mismatch`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const head = JSON.parse(text) as {
    schema?: string;
    schema_version?: number;
    kind?: string;
  };
  if (head.schema !== SCHEMA || head.schema_version !== SCHEMA_VERSION) {
    throw new Error(`${f.path}: wrong schema header`);
  }
  const parts = splitChunks(text);
  for (let i = 0; i < parts.length; i++)
    await deps.kv.set(K.chunk(sha, i), parts[i] as string);
  await deps.kv.set(K.blob(sha), String(parts.length));
  return {
    sha256: sha,
    bytes: f.bytes,
    chars: text.length,
    chunks: parts.length,
    kind: f.kind,
    dest: f.dest ?? null,
  };
}

/** Delete generations other than current + previous, and blobs only they used. */
async function collectGarbage(deps: SyncDeps, keep: string[]): Promise<void> {
  const { kv } = deps;
  const gens = (await readJson<string[]>(kv, K.gens)) ?? [];
  const keptShas = new Set<string>();
  for (const g of keep) {
    const m = await readJson<GenMeta>(kv, K.meta(g));
    for (const f of Object.values(m?.files ?? {})) keptShas.add(f.sha256);
  }
  for (const g of gens) {
    if (keep.includes(g)) continue;
    const m = await readJson<GenMeta>(kv, K.meta(g));
    for (const f of Object.values(m?.files ?? {})) {
      if (keptShas.has(f.sha256)) continue;
      // A failed run's meta has chunks 0: use the blob's own marker, else probe.
      let n = f.chunks || Number((await kv.get(K.blob(f.sha256))) ?? 0);
      if (!n) while (n < 16 && (await kv.get(K.chunk(f.sha256, n)))) n++;
      const keys = [K.blob(f.sha256)];
      for (let i = 0; i < Math.max(1, n); i++) keys.push(K.chunk(f.sha256, i));
      await kv.del(...keys);
      keptShas.add(f.sha256); // don't delete twice
    }
    await kv.del(K.meta(g));
  }
  await kv.set(K.gens, JSON.stringify(keep));
}

export async function refreshBundle(
  deps: SyncDeps,
  opts: { force?: boolean } = {}
): Promise<RefreshResult> {
  const { kv, log } = deps;
  const got = await kv.set(K.lock, '1', {
    nx: true,
    expiration: new Date(deps.now().getTime() + LOCK_TTL_S * 1000),
  });
  if (got !== 'OK') return { status: 'locked' };
  try {
    const raw = await getBytes(deps.fetch, MANIFEST_URL);
    const manifest = checkManifest(JSON.parse(new TextDecoder().decode(raw)));
    const gen = manifest.generation;
    const current = (await kv.get(K.current)) ?? null;
    if (current === gen && !opts.force) {
      const m = await readJson<GenMeta>(kv, K.meta(gen));
      if (m?.complete) {
        await kv.set(
          K.status,
          JSON.stringify({
            at: deps.now().toISOString(),
            status: 'unchanged',
            generation: gen,
          })
        );
        return { status: 'unchanged', generation: gen };
      }
    }
    // Register the generation before writing anything, so a failed run's
    // blobs are still found (and deleted) by the next garbage collection.
    const gens = (await readJson<string[]>(kv, K.gens)) ?? [];
    if (!gens.includes(gen))
      await kv.set(K.gens, JSON.stringify([...gens, gen]));
    const meta: GenMeta = {
      generation: gen,
      generated_at: manifest.generated_at,
      stored_at: deps.now().toISOString(),
      complete: false,
      common: manifest.common,
      destinations: manifest.destinations,
      files: {},
      total_bytes: 0,
    };
    for (const f of manifest.files) {
      meta.files[f.path] = {
        sha256: f.sha256,
        bytes: f.bytes,
        chars: 0,
        chunks: 0,
        kind: f.kind,
        dest: f.dest ?? null,
      };
    }
    await kv.set(K.meta(gen), JSON.stringify(meta));

    const previousMeta = current
      ? await readJson<GenMeta>(kv, K.meta(current))
      : null;
    const known = new Map(
      Object.values(previousMeta?.files ?? {}).map((f) => [f.sha256, f])
    );
    let downloaded = 0;
    for (const f of manifest.files) {
      const same = known.get(f.sha256);
      if (same && (await hasBlob(kv, f.sha256, same.chunks))) {
        meta.files[f.path] = { ...same, kind: f.kind, dest: f.dest ?? null };
      } else {
        meta.files[f.path] = await storeFile(deps, manifest.base_url, f);
        downloaded++;
      }
      meta.total_bytes += f.bytes;
    }
    meta.complete = true;
    await kv.set(K.meta(gen), JSON.stringify(meta));

    // Flip. `current` is the only key readers follow; one SET is atomic.
    const previous =
      current && current !== gen
        ? current
        : ((await kv.get(K.previous)) ?? null);
    if (previous) await kv.set(K.previous, previous);
    await kv.set(K.current, gen);
    await collectGarbage(deps, [gen, ...(previous ? [previous] : [])]);

    const chunks = Object.values(meta.files).reduce((s, f) => s + f.chunks, 0);
    await kv.set(
      K.status,
      JSON.stringify({
        at: deps.now().toISOString(),
        status: 'updated',
        generation: gen,
        bytes: meta.total_bytes,
      })
    );
    log.info(
      `[bundle] generation ${gen} stored (${manifest.files.length} files, ${meta.total_bytes} bytes, ${chunks} chunks, ${downloaded} downloaded); previous ${previous ?? 'none'}`
    );
    return {
      status: 'updated',
      generation: gen,
      previous,
      bytes: meta.total_bytes,
      chunks,
      downloaded,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      `[bundle] refresh failed (${message}); keeping the current generation`
    );
    await kv
      .set(
        K.status,
        JSON.stringify({
          at: deps.now().toISOString(),
          status: 'error',
          message,
        })
      )
      .catch(() => undefined);
    return { status: 'error', message };
  } finally {
    await kv.del(K.lock).catch(() => undefined);
  }
}
