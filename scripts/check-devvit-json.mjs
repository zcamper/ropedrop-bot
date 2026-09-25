// Offline validation of devvit.json using the same parser the Devvit CLI runs
// before playtest/upload (@devvit/shared-types parseAppConfig, JSON Schema
// config-file.v1). Also checks the built server bundle exists. No network.
import { existsSync, readFileSync } from 'node:fs';
import { parseAppConfig } from '@devvit/shared-types/schemas/config-file.v1.js';

const cfg = parseAppConfig(readFileSync('devvit.json', 'utf8'), false);
const entry = `${cfg.server.dir}/${cfg.server.entry}`;
if (!existsSync(entry)) {
  console.error(
    `devvit.json OK, but server bundle ${entry} is missing — run npm run build`
  );
  process.exit(1);
}
const domains = cfg.permissions?.http?.domains ?? [];
if (domains.length !== 1 || domains[0] !== 'ropedropplanner.com') {
  console.error(
    `HTTP allowlist must be exactly ["ropedropplanner.com"], got ${JSON.stringify(domains)}`
  );
  process.exit(1);
}
console.log(
  `devvit.json valid (app "${cfg.name}", server ${entry}, http ${JSON.stringify(domains)})`
);
