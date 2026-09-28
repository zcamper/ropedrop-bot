import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { devvit } from '@devvit/start/vite';

// The baseline data snapshot (scripts/snapshot-bundle.mjs -> snapshot/) is
// inlined into the server bundle as base64 of the gzipped container, so the
// app can answer before (or without) its daily fetch.
const SNAPSHOT = resolve(import.meta.dirname, 'snapshot', 'bundle.json.gz');
const VIRTUAL = 'virtual:rdb-snapshot';

function embeddedSnapshot(): Plugin {
  return {
    name: 'rdb-embedded-snapshot',
    resolveId(id) {
      return id === VIRTUAL ? `\0${VIRTUAL}` : null;
    },
    load(id) {
      if (id !== `\0${VIRTUAL}`) return null;
      if (!existsSync(SNAPSHOT)) {
        this.error(
          `${SNAPSHOT} is missing: run "npm run snapshot" (downloads the current public data bundle)`
        );
      }
      this.addWatchFile(SNAPSHOT);
      const b64 = readFileSync(SNAPSHOT).toString('base64');
      return `export default ${JSON.stringify(b64)};`;
    },
  };
}

export default defineConfig({
  plugins: [embeddedSnapshot(), devvit()],
});
