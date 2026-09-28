// Build the frozen, trimmed bundle snapshot the unit tests run against
// (test/fixtures/bundle). Input: a local copy of one bundle generation laid
// out like the bucket (manifest.json + g/<generation>/...). No network.
//
//   node scripts/make-fixture-bundle.mjs <downloaded-bundle-dir>
//
// Trimming keeps everything the answer logic reads (all rides, hours,
// crowds, outlook, patterns, rain, events, LL) and drops what it doesn't
// (shows, the per-pavilion DAW drink lists) plus menus other than the
// restaurants the tests ask about. Files are stored gzipped.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/make-fixture-bundle.mjs <bundle-dir>');
  process.exit(2);
}
const out = join('test', 'fixtures', 'bundle');
const MENU_WORDS = /dole whip|churro|pretzel|turkey leg/i;
const MENU_NAMES = /^(be our guest restaurant|space 220 lounge)$/i;

const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
rmSync(out, { recursive: true, force: true });
let total = 0;
for (const f of manifest.files) {
  const doc = JSON.parse(readFileSync(join(src, f.path), 'utf8'));
  if (doc.kind === 'core') {
    doc.shows = {};
  } else if (doc.kind === 'daw') {
    for (const p of doc.pavilions) p.drinks = [];
  } else if (doc.kind === 'menus') {
    doc.restaurants = Object.fromEntries(
      Object.entries(doc.restaurants).filter(
        ([, r]) =>
          MENU_NAMES.test(r.name) ||
          Object.values(r.periods).some((secs) =>
            Object.values(secs).some((items) =>
              items.some(([n]) => MENU_WORDS.test(n))
            )
          )
      )
    );
  }
  const gz = gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 });
  const dest = join(out, `${f.path}.gz`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, gz);
  total += gz.length;
}
writeFileSync(
  join(out, 'manifest.json'),
  JSON.stringify(manifest, null, 1) + '\n'
);
console.log(
  `wrote ${out} (${manifest.files.length} files, ${total} bytes gzipped, generation ${manifest.generation})`
);
