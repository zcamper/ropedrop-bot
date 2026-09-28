// The baseline data snapshot built into the app (scripts/snapshot-bundle.mjs
// at build time), and the choice between it and the daily-refreshed copy in
// Redis. The embedded copy is read straight from memory and is never written
// to Redis. Pure (no Devvit imports) so tests can run it.

import { gunzipSync } from 'node:zlib';
import { LayoutSource, openRedisBundle } from './source.js';
import type { GenMeta, KV } from './sync.js';

export const EMBEDDED_FORMAT = 'rdb-embedded-v1';

type Container = {
  format: string;
  generation: string;
  generated_at: string;
  fetched_at?: string;
  layout: Pick<
    GenMeta,
    'generation' | 'generated_at' | 'common' | 'destinations'
  >;
  files: Record<string, string>;
};

export type EmbeddedSnapshot = {
  generation: string;
  generatedAt: string;
  files: number;
  gzBytes: number;
  jsonBytes: number;
  source: LayoutSource;
};

/** Decode the gzipped container (base64 in the server bundle). Throws on anything malformed. */
export function decodeEmbedded(gz: Uint8Array): EmbeddedSnapshot {
  const json = gunzipSync(gz); // gzip's CRC-32 catches a corrupted payload
  const c = JSON.parse(json.toString('utf8')) as Container;
  if (c?.format !== EMBEDDED_FORMAT)
    throw new Error(`unknown embedded format ${String(c?.format)}`);
  if (!Number.isFinite(Date.parse(c.generated_at)))
    throw new Error('embedded snapshot has no generated_at');
  if (!c.files || typeof c.files[c.layout?.common] !== 'string')
    throw new Error('embedded snapshot has no common.json');
  const files = c.files;
  const source = new LayoutSource(c.layout, async (path) => {
    const text = files[path];
    if (typeof text !== 'string')
      throw new Error(`embedded snapshot has no ${path}`);
    return text;
  });
  return {
    generation: c.generation,
    generatedAt: c.generated_at,
    files: Object.keys(files).length,
    gzBytes: gz.byteLength,
    jsonBytes: json.byteLength,
    source,
  };
}

/** Decode from base64; returns null (and says why) instead of throwing. */
export function loadEmbedded(
  base64: string | undefined,
  log: (m: string) => void
): EmbeddedSnapshot | null {
  if (!base64) {
    log('[bundle] no embedded snapshot in this build');
    return null;
  }
  try {
    const snap = decodeEmbedded(Buffer.from(base64, 'base64'));
    log(
      `[bundle] embedded snapshot ${snap.generation} loaded (generated ${snap.generatedAt}, ` +
        `${snap.files} files, ${snap.gzBytes} bytes gz, ${snap.jsonBytes} bytes json)`
    );
    return snap;
  } catch (err) {
    log(
      `[bundle] embedded snapshot unreadable (${err instanceof Error ? err.message : String(err)})`
    );
    return null;
  }
}

/** A readable bundle generation plus where it came from, for logs. */
export type DataSource = {
  src: LayoutSource;
  kind: 'redis' | 'embedded';
  generation: string;
  generatedAt: string;
  /** e.g. "redis:20260928T1750Z" or "embedded:20260928T1750Z". */
  label: string;
};

function tag(
  src: LayoutSource,
  kind: DataSource['kind'],
  generation: string
): DataSource {
  return {
    src,
    kind,
    generation,
    generatedAt: src.generatedAt(),
    label: `${kind}:${generation}`,
  };
}

const ts = (s: DataSource) => {
  const t = Date.parse(s.generatedAt);
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Every usable data source, newest first: the generation stored in Redis by
 * the daily fetch and the embedded snapshot, ordered by `generated_at`
 * (Redis wins a tie). Callers try them in order, so an unreadable Redis
 * generation falls back to the embedded one. A Redis error never throws.
 */
export async function dataSources(
  kv: KV,
  embedded: EmbeddedSnapshot | null,
  log?: (m: string) => void
): Promise<DataSource[]> {
  const out: DataSource[] = [];
  try {
    const r = await openRedisBundle(kv);
    if (r) out.push(tag(r, 'redis', await r.generation()));
  } catch (err) {
    log?.(
      `[bundle] redis generation unreadable (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (embedded) out.push(tag(embedded.source, 'embedded', embedded.generation));
  return out.sort((a, b) => ts(b) - ts(a));
}
