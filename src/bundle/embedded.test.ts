import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { askFromSources } from '../bot/service.js';
import { fixtureManifest, readFixture } from '../testutil/bundle.js';
import {
  dataSources,
  decodeEmbedded,
  EMBEDDED_FORMAT,
  loadEmbedded,
} from './embedded.js';
import { K, type GenMeta, type KV } from './sync.js';

const NOW = new Date('2026-09-28T15:00:00Z');

/** The container scripts/snapshot-bundle.mjs writes, built from the fixture. */
function container(generatedAt = '2026-09-28T17:50:11Z') {
  const m = fixtureManifest();
  const files: Record<string, string> = {};
  for (const f of m.files) files[f.path] = readFixture(f.path);
  return {
    format: EMBEDDED_FORMAT,
    generation: m.generation,
    generated_at: generatedAt,
    layout: {
      generation: m.generation,
      generated_at: generatedAt,
      common: m.common,
      destinations: m.destinations,
    },
    files,
  };
}

const gz = (c: unknown) => gzipSync(Buffer.from(JSON.stringify(c)));

class MemKV implements KV {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k);
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
  async del(...ks: string[]) {
    for (const k of ks) this.m.delete(k);
  }
}

/** Store the fixture in Redis as generation `gen` (what a daily refresh leaves behind). */
function redisWith(gen: string, generatedAt: string): MemKV {
  const kv = new MemKV();
  const m = fixtureManifest();
  const meta: GenMeta = {
    generation: gen,
    generated_at: generatedAt,
    stored_at: generatedAt,
    complete: true,
    common: m.common,
    destinations: m.destinations,
    files: {},
    total_bytes: 0,
  };
  m.files.forEach((f, i) => {
    const text = readFixture(f.path);
    const sha = `${gen}-${i}`;
    kv.m.set(K.chunk(sha, 0), text);
    kv.m.set(K.blob(sha), '1');
    meta.files[f.path] = {
      sha256: sha,
      bytes: f.bytes,
      chars: text.length,
      chunks: 1,
      kind: f.kind,
      dest: f.dest ?? null,
    };
  });
  kv.m.set(K.meta(gen), JSON.stringify(meta));
  kv.m.set(K.current, gen);
  return kv;
}

void test('embedded snapshot: decodes from base64 gzip and answers with no Redis and no fetch', async () => {
  const logs: string[] = [];
  const snap = loadEmbedded(gz(container()).toString('base64'), (m) =>
    logs.push(m)
  );
  assert.ok(snap);
  assert.equal(snap.generation, fixtureManifest().generation);
  assert.match(
    logs[0] as string,
    /^\[bundle\] embedded snapshot 20260928T1750Z loaded \(generated 2026-09-28T17:50:11Z, 21 files, /
  );
  const sources = await dataSources(new MemKV(), snap);
  assert.deepEqual(
    sources.map((s) => s.label),
    ['embedded:20260928T1750Z']
  );
  const r = await askFromSources(
    sources,
    NOW,
    'When is the best time to ride Slinky Dog Dash?'
  );
  assert.ok(r.ok);
  assert.ok(r.data.confidence >= 0.7);
  assert.equal(r.data.source, 'embedded:20260928T1750Z');
});

void test('embedded snapshot: missing or corrupt payload -> null with a reason, never a throw', () => {
  const logs: string[] = [];
  assert.equal(
    loadEmbedded(undefined, (m) => logs.push(m)),
    null
  );
  const bytes = gz(container());
  bytes[bytes.length - 6] = (bytes[bytes.length - 6] as number) ^ 0xff; // break the CRC
  assert.equal(
    loadEmbedded(bytes.toString('base64'), (m) => logs.push(m)),
    null
  );
  assert.throws(
    () => decodeEmbedded(gz({ ...container(), format: 'x' })),
    /unknown embedded format/
  );
  assert.match(logs.join('\n'), /no embedded snapshot/);
  assert.match(logs.join('\n'), /embedded snapshot unreadable/);
});

void test('load order: the newer of Redis and the embedded snapshot comes first; Redis wins a tie', async () => {
  const snap = decodeEmbedded(gz(container('2026-09-28T17:50:11Z')));
  const newer = await dataSources(
    redisWith('20260929T0815Z', '2026-09-29T08:15:00Z'),
    snap
  );
  assert.deepEqual(
    newer.map((s) => s.label),
    ['redis:20260929T0815Z', 'embedded:20260928T1750Z']
  );
  const older = await dataSources(
    redisWith('20260920T0815Z', '2026-09-20T08:15:00Z'),
    snap
  );
  assert.deepEqual(
    older.map((s) => s.label),
    ['embedded:20260928T1750Z', 'redis:20260920T0815Z']
  );
  const tie = await dataSources(
    redisWith('20260928T1750Z', '2026-09-28T17:50:11Z'),
    snap
  );
  assert.equal(tie[0]?.kind, 'redis');
});

void test('load order: an unreadable Redis generation falls back to the embedded snapshot', async () => {
  const snap = decodeEmbedded(gz(container()));
  const kv = redisWith('20260929T0815Z', '2026-09-29T08:15:00Z');
  for (const k of kv.m.keys())
    if (k.startsWith('bundle:v1:blob:') && k.endsWith(':0')) kv.m.delete(k);
  const r = await askFromSources(
    await dataSources(kv, snap),
    NOW,
    'When is the best time to ride Slinky Dog Dash?'
  );
  assert.ok(r.ok);
  assert.equal(r.data.source, 'embedded:20260928T1750Z');

  // A Redis error while opening never throws either.
  const failing: KV = {
    get: () => Promise.reject(new Error('redis down')),
    set: () => Promise.resolve('OK'),
    del: () => Promise.resolve(0),
  };
  const logs: string[] = [];
  const only = await dataSources(failing, snap, (m) => logs.push(m));
  assert.deepEqual(
    only.map((s) => s.kind),
    ['embedded']
  );
  assert.match(logs[0] as string, /redis generation unreadable \(redis down\)/);
});
