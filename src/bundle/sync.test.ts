import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Manifest } from '../bot/types.js';
import { readFixture, fixtureManifest } from '../testutil/bundle.js';
import { sha256Hex, sha256HexSync } from './sha256.js';
import { openRedisBundle } from './source.js';
import {
  checkManifest,
  CHUNK_CHARS,
  K,
  MANIFEST_URL,
  refreshBundle,
  splitChunks,
  type KV,
  type SyncDeps,
} from './sync.js';

class MemKV implements KV {
  m = new Map<string, string>();
  sets = 0;
  async get(k: string) {
    return this.m.get(k);
  }
  async set(k: string, v: string, o?: { nx?: boolean }) {
    if (o?.nx && this.m.has(k)) return null;
    this.m.set(k, v);
    this.sets++;
    return 'OK';
  }
  async del(...ks: string[]) {
    for (const k of ks) this.m.delete(k);
  }
  bytes(prefix: string): number {
    let n = 0;
    for (const [k, v] of this.m)
      if (k.startsWith(prefix)) n += Buffer.byteLength(v);
    return n;
  }
}

type Served = { manifest: Manifest; files: Map<string, Buffer> };

/** A bundle generation built from the fixture files (re-headed + re-hashed). */
function makeGeneration(
  gen: string,
  mutate?: (path: string, doc: Record<string, unknown>) => void
): Served {
  const base = fixtureManifest();
  const files = new Map<string, Buffer>();
  const entries: Manifest['files'] = [];
  const rename = (p: string) => p.replace(/^g\/[^/]+\//, `g/${gen}/`);
  for (const f of base.files) {
    const doc = JSON.parse(readFixture(f.path)) as Record<string, unknown>;
    doc.generated_at = `gen-${gen}`;
    mutate?.(f.path, doc);
    const buf = Buffer.from(JSON.stringify(doc));
    const path = rename(f.path);
    files.set(path, buf);
    entries.push({
      ...f,
      path,
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    });
  }
  const dests = JSON.parse(
    JSON.stringify(base.destinations).replaceAll(
      `g/${base.generation}/`,
      `g/${gen}/`
    )
  );
  return {
    manifest: {
      ...base,
      generation: gen,
      generated_at: '2026-09-28T17:50:11Z',
      common: rename(base.common),
      destinations: dests,
      files: entries,
    },
    files,
  };
}

function deps(
  kv: MemKV,
  served: { current: Served; fetched: string[]; corrupt?: string }
): SyncDeps {
  return {
    kv,
    now: () => new Date('2026-09-28T13:00:00Z'),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    fetch: async (url: string) => {
      served.fetched.push(url);
      if (url === MANIFEST_URL)
        return new Response(JSON.stringify(served.current.manifest));
      const path = url.slice(served.current.manifest.base_url.length);
      let body = served.current.files.get(path);
      if (!body) return new Response('nope', { status: 404 });
      if (served.corrupt === path)
        body = Buffer.concat([
          body.subarray(0, body.length - 1),
          Buffer.from(' '),
        ]);
      return new Response(new Uint8Array(body));
    },
  };
}

void test('sha256: WebCrypto and the pure-JS fallback agree with node:crypto', async () => {
  for (const s of [
    '',
    'abc',
    'x'.repeat(1000),
    JSON.stringify({ a: 'é\u{1F600}' }),
  ]) {
    const b = new TextEncoder().encode(s);
    const want = createHash('sha256').update(b).digest('hex');
    assert.equal(sha256HexSync(b), want);
    assert.equal(await sha256Hex(b), want);
  }
});

void test('splitChunks keeps every value small and never splits a surrogate pair', () => {
  const s = 'a'.repeat(9) + '\u{1F600}' + 'b'.repeat(5);
  const parts = splitChunks(s, 10);
  assert.equal(parts.join(''), s);
  assert.ok(parts.every((p) => !/[\uD800-\uDBFF]$/.test(p)));
  assert.ok(
    CHUNK_CHARS * 3 < 4 * 1024 * 1024,
    'a chunk is < 4 MB even at 3 bytes/char'
  );
});

void test('manifest checks: schema, allow-listed host, safe paths', () => {
  const ok = makeGeneration('20260928T1750Z').manifest;
  assert.equal(checkManifest(ok).generation, '20260928T1750Z');
  assert.throws(
    () => checkManifest({ ...ok, schema_version: 2 }),
    /unsupported schema/
  );
  assert.throws(
    () => checkManifest({ ...ok, base_url: 'https://example.com/bundle/v1/' }),
    /allow-listed/
  );
  assert.throws(
    () =>
      checkManifest({
        ...ok,
        files: [{ ...ok.files[0]!, path: '../etc/passwd' }],
      }),
    /bad file entry/
  );
});

void test('refresh: store, skip when unchanged, flip atomically, keep previous, GC older', async () => {
  const kv = new MemKV();
  const s = { current: makeGeneration('G1'), fetched: [] as string[] };
  const d = deps(kv, s);

  const r1 = await refreshBundle(d);
  assert.equal(r1.status, 'updated');
  assert.equal(await kv.get(K.current), 'G1');
  assert.equal(s.fetched.length, 1 + s.current.manifest.files.length);
  const src1 = await openRedisBundle(kv);
  assert.equal(await src1?.generation(), 'G1');
  assert.equal((await src1?.core('wdw'))?.name, 'Walt Disney World');

  // Same generation: one manifest GET, nothing rewritten.
  s.fetched.length = 0;
  const sets = kv.sets;
  assert.deepEqual(await refreshBundle(d), {
    status: 'unchanged',
    generation: 'G1',
  });
  assert.equal(s.fetched.length, 1);
  assert.equal(kv.sets, sets + 2); // the lock and the status key only

  // New generation: previous kept, pointer flipped.
  s.current = makeGeneration('G2');
  const r2 = await refreshBundle(d);
  assert.equal(r2.status, 'updated');
  assert.equal(await kv.get(K.current), 'G2');
  assert.equal(await kv.get(K.previous), 'G1');

  // Third generation: G1 and the blobs only it used are deleted.
  const g1Meta = JSON.parse((await kv.get(K.meta('G1'))) as string) as {
    files: Record<string, { sha256: string }>;
  };
  s.current = makeGeneration('G3');
  await refreshBundle(d);
  assert.equal(await kv.get(K.meta('G1')), undefined);
  for (const f of Object.values(g1Meta.files))
    assert.equal(await kv.get(K.blob(f.sha256)), undefined);
  assert.deepEqual(JSON.parse((await kv.get(K.gens)) as string), ['G3', 'G2']);
  assert.equal(await kv.get(K.lock), undefined);
});

void test('refresh: a bad file (sha256/bytes) aborts; readers keep the old generation', async () => {
  const kv = new MemKV();
  const s: { current: Served; fetched: string[]; corrupt?: string } = {
    current: makeGeneration('G1'),
    fetched: [],
  };
  await refreshBundle(deps(kv, s));
  s.current = makeGeneration('G2');
  s.corrupt = s.current.manifest.files[3]!.path;
  const r = await refreshBundle(deps(kv, s));
  assert.equal(r.status, 'error');
  assert.match((r as { message: string }).message, /sha256 mismatch/);
  assert.equal(await kv.get(K.current), 'G1');
  const src = await openRedisBundle(kv);
  assert.equal(await src?.generation(), 'G1');
  // The half-written generation is cleaned up by the next successful run.
  delete s.corrupt;
  s.current = makeGeneration('G3');
  await refreshBundle(deps(kv, s));
  assert.equal(await kv.get(K.meta('G2')), undefined);
});

void test('reader falls back to the previous generation when a current file is unreadable', async () => {
  const kv = new MemKV();
  const s = { current: makeGeneration('G1'), fetched: [] as string[] };
  await refreshBundle(deps(kv, s));
  s.current = makeGeneration('G2', (path, doc) => {
    if (path.endsWith('wdw/core.json')) doc.name = 'WDW (G2)';
  });
  await refreshBundle(deps(kv, s));
  const meta = JSON.parse((await kv.get(K.meta('G2'))) as string) as {
    files: Record<string, { sha256: string }>;
  };
  const corePath = Object.keys(meta.files).find((p) =>
    p.endsWith('wdw/core.json')
  ) as string;
  assert.equal(
    (await (await openRedisBundle(kv))?.core('wdw'))?.name,
    'WDW (G2)'
  );
  await kv.del(K.chunk(meta.files[corePath]!.sha256, 0));
  assert.equal(
    (await (await openRedisBundle(kv))?.core('wdw'))?.name,
    'Walt Disney World'
  );
});

void test('no bundle stored yet -> openRedisBundle returns null; concurrent refresh is locked out', async () => {
  const kv = new MemKV();
  assert.equal(await openRedisBundle(kv), null);
  await kv.set(K.lock, '1');
  const s = { current: makeGeneration('G1'), fetched: [] as string[] };
  assert.deepEqual(await refreshBundle(deps(kv, s)), { status: 'locked' });
  assert.equal(s.fetched.length, 0);
});
