// Build-time snapshot of the public data bundle, embedded in the server
// bundle so the app can answer with zero external requests (the daily fetch
// only keeps it fresh). Runs on the developer machine, never inside Reddit.
//
//   node scripts/snapshot-bundle.mjs              download the current generation
//   node scripts/snapshot-bundle.mjs --if-missing keep an existing snapshot (offline builds/tests)
//
// Steps: GET the manifest, check schema + host, GET every file, verify byte
// count and sha256 against the manifest, drop fields the answers never read,
// and write one gzipped JSON container to snapshot/bundle.json.gz, which
// vite.config.ts inlines into dist/server/index.cjs (virtual:rdb-snapshot).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const HOST = 'ropedrop-bot-data.storage.googleapis.com';
const MANIFEST_URL = `https://${HOST}/bundle/v1/manifest.json`;
const SCHEMA = 'ropedrop-bot-bundle';
const SCHEMA_VERSION = 1;
const FORMAT = 'rdb-embedded-v1';
const OUT_DIR = 'snapshot';
const OUT = join(OUT_DIR, 'bundle.json.gz');
const INFO = join(OUT_DIR, 'info.json');
/** Keep the embedded data well inside the server bundle budget. */
const MAX_GZ_BYTES = 1_500_000;
const TIMEOUT_MS = 60_000;

function fail(msg) {
  console.error(`[snapshot] ${msg}`);
  process.exit(1);
}

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const rsp = await fetch(url, { method: 'GET', signal: ctrl.signal });
    if (!rsp.ok) throw new Error(`HTTP ${rsp.status} for ${url}`);
    return Buffer.from(await rsp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

const safePath = (p) =>
  typeof p === 'string' &&
  /^[A-Za-z0-9_./-]+$/.test(p) &&
  !p.includes('..') &&
  !p.startsWith('/');

function checkManifest(m) {
  if (m?.schema !== SCHEMA || m?.schema_version !== SCHEMA_VERSION)
    throw new Error(`unsupported schema ${m?.schema} v${m?.schema_version}`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(m.generation ?? ''))
    throw new Error('bad generation');
  if (!Number.isFinite(Date.parse(m.generated_at)))
    throw new Error('bad generated_at');
  if (!String(m.base_url).startsWith(`https://${HOST}/`))
    throw new Error('base_url is not on the allow-listed host');
  if (!Array.isArray(m.files) || !m.files.length)
    throw new Error('manifest has no files');
  for (const f of m.files) {
    if (!safePath(f.path) || !/^[0-9a-f]{64}$/.test(f.sha256) || !(f.bytes > 0))
      throw new Error(`bad file entry ${f?.path}`);
  }
  if (!m.files.some((f) => f.path === m.common))
    throw new Error('bad common path');
}

/** Drop what no answer reads (same trimming as the test fixture). */
function trim(doc) {
  if (doc.kind === 'core') {
    doc.shows = {};
  } else if (doc.kind === 'events') {
    delete doc.showtimes;
    delete doc.showtimes_note;
    delete doc.park_events;
  } else if (doc.kind === 'daw') {
    for (const p of doc.pavilions ?? []) p.drinks = [];
  }
  return doc;
}

async function main() {
  const ifMissing = process.argv.includes('--if-missing');
  if (ifMissing && existsSync(OUT)) {
    const info = JSON.parse(readFileSync(INFO, 'utf8'));
    console.log(
      `[snapshot] keeping ${OUT} (generation ${info.generation}, ${info.gz_bytes} bytes gz)`
    );
    return;
  }

  const manifest = JSON.parse((await get(MANIFEST_URL)).toString('utf8'));
  checkManifest(manifest);
  const files = {};
  const sha256 = {};
  let rawBytes = 0;
  for (const f of manifest.files) {
    const bytes = await get(manifest.base_url + f.path);
    if (bytes.length !== f.bytes)
      throw new Error(
        `${f.path}: ${bytes.length} bytes, manifest says ${f.bytes}`
      );
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== f.sha256) throw new Error(`${f.path}: sha256 mismatch`);
    const doc = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    if (doc.schema !== SCHEMA || doc.schema_version !== SCHEMA_VERSION)
      throw new Error(`${f.path}: wrong schema header`);
    files[f.path] = JSON.stringify(trim(doc));
    sha256[f.path] = sha;
    rawBytes += bytes.length;
  }

  const container = {
    format: FORMAT,
    generation: manifest.generation,
    generated_at: manifest.generated_at,
    fetched_at: new Date().toISOString(),
    source: MANIFEST_URL,
    layout: {
      generation: manifest.generation,
      generated_at: manifest.generated_at,
      common: manifest.common,
      destinations: manifest.destinations,
    },
    sha256,
    files,
  };
  const json = Buffer.from(JSON.stringify(container), 'utf8');
  const gz = gzipSync(json, { level: 9 });
  if (gz.length > MAX_GZ_BYTES)
    throw new Error(
      `snapshot is ${gz.length} bytes gz (limit ${MAX_GZ_BYTES}); trim more`
    );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, gz);
  const info = {
    generation: manifest.generation,
    generated_at: manifest.generated_at,
    fetched_at: container.fetched_at,
    files: manifest.files.length,
    source_bytes: rawBytes,
    json_bytes: json.length,
    gz_bytes: gz.length,
    base64_bytes: Math.ceil(gz.length / 3) * 4,
  };
  writeFileSync(INFO, JSON.stringify(info, null, 1) + '\n');
  console.log(
    `[snapshot] ${OUT}: generation ${info.generation} (${info.generated_at}), ${info.files} files, ` +
      `${rawBytes} bytes downloaded (sha256 verified) -> ${json.length} trimmed -> ${gz.length} gz ` +
      `(${info.base64_bytes} base64 in the server bundle)`
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
