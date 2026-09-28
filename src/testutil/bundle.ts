// Test helper: a BundleSource over the frozen, trimmed bundle snapshot in
// test/fixtures/bundle (manifest.json + g/<generation>/...json.gz), built by
// scripts/make-fixture-bundle.mjs. Read from disk; no network.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Manifest } from '../bot/types.js';
import { LayoutSource } from '../bundle/source.js';

export const FIXTURE_DIR =
  process.env.BUNDLE_FIXTURE_DIR ??
  join(process.cwd(), 'test', 'fixtures', 'bundle');

export function fixtureManifest(): Manifest {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8')
  ) as Manifest;
}

export function readFixture(path: string): string {
  const p = join(FIXTURE_DIR, path);
  if (existsSync(`${p}.gz`))
    return gunzipSync(readFileSync(`${p}.gz`)).toString('utf8');
  return readFileSync(p, 'utf8');
}

export function fixtureSource(): LayoutSource {
  return new LayoutSource(fixtureManifest(), async (path) => readFixture(path));
}
