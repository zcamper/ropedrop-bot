// Offline validation of devvit.json using the same parser the Devvit CLI runs
// before playtest/upload (@devvit/shared-types parseAppConfig, JSON Schema
// config-file.v1). Also checks the built server bundle exists and that the
// app can fetch from exactly one host: the public data-bundle bucket. No network.
import { existsSync, readFileSync } from 'node:fs';
import { parseAppConfig } from '@devvit/shared-types/schemas/config-file.v1.js';

const BUNDLE_HOST = 'ropedrop-bot-data.storage.googleapis.com';

const cfg = parseAppConfig(readFileSync('devvit.json', 'utf8'), false);
const entry = `${cfg.server.dir}/${cfg.server.entry}`;
if (!existsSync(entry)) {
  console.error(
    `devvit.json OK, but server bundle ${entry} is missing — run npm run build`
  );
  process.exit(1);
}
const domains = cfg.permissions?.http?.domains ?? [];
if (domains.length !== 1 || domains[0] !== BUNDLE_HOST) {
  console.error(
    `HTTP allowlist must be exactly ["${BUNDLE_HOST}"], got ${JSON.stringify(domains)}`
  );
  process.exit(1);
}
if (cfg.settings?.global && Object.keys(cfg.settings.global).length) {
  console.error(
    `No global settings expected (no secrets), got ${Object.keys(cfg.settings.global)}`
  );
  process.exit(1);
}
// The server bundle must not call anything but the bundle host.
const bundle = readFileSync(entry, 'utf8');
if (/ropedropplanner\.com\/api\//.test(bundle)) {
  console.error('server bundle still references ropedropplanner.com/api/');
  process.exit(1);
}
// Every build carries the baseline data snapshot, so the app answers even
// before (or without) its daily fetch.
const info = existsSync('snapshot/info.json')
  ? JSON.parse(readFileSync('snapshot/info.json', 'utf8'))
  : null;
if (!info || !bundle.includes('] embedded snapshot ')) {
  console.error(
    'server bundle has no embedded data snapshot — run npm run snapshot, then npm run build'
  );
  process.exit(1);
}
const b64 = readFileSync('snapshot/bundle.json.gz').toString('base64');
if (!bundle.includes(b64.slice(0, 64)) || !bundle.includes(b64.slice(-64))) {
  console.error(
    'server bundle does not contain the current snapshot/bundle.json.gz — rebuild'
  );
  process.exit(1);
}
console.log(
  `devvit.json valid (app "${cfg.name}", server ${entry}, http ${JSON.stringify(domains)}); ` +
    `embedded data ${info.generation} (${info.generated_at}, ${info.gz_bytes} bytes gz)`
);
