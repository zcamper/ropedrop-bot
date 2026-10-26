// Test helper: the frozen bundle snapshot (common/core/events/menus from
// test/fixtures/bundle) plus the parties + menu_items files and the backend's
// own answers in test/fixtures/party_menu/<set>/ (built by
// scripts/parity/gen_party_menu_expected.py from the backend exporter).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BundleSource,
  Dest,
  MenuItemsFile,
  Parties,
} from '../bot/types.js';
import { fixtureSource } from './bundle.js';

export const PARTY_MENU_DIR = join(
  process.cwd(),
  'test',
  'fixtures',
  'party_menu'
);

export type Expected = {
  now: string;
  today: string;
  cases: {
    q: string;
    intent: string;
    confidence: number;
    answer: string;
    links: string[];
  }[];
};

function readJson<T>(path: string): T | null {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as T)
    : null;
}

export function expected(set: string): Expected {
  return readJson<Expected>(
    join(PARTY_MENU_DIR, set, 'expected.json')
  ) as Expected;
}

/** `overrides` patches the loaded files (e.g. add a regular-day character). */
export function partyMenuSource(
  set: string,
  overrides: { parties?: (d: Dest, p: Parties) => Parties } = {}
): BundleSource {
  const base = fixtureSource();
  const dir = join(PARTY_MENU_DIR, set);
  return {
    generation: () => base.generation(),
    common: () => base.common(),
    core: (d) => base.core(d),
    events: (d) => base.events(d),
    ll: (d) => base.ll(d),
    daw: (d) => base.daw(d),
    menus: (d, p) => base.menus(d, p),
    menuParts: (d) => base.menuParts(d),
    parties: async (d) => {
      const p = readJson<Parties>(join(dir, `${d}.parties.json`));
      return p && overrides.parties ? overrides.parties(d, p) : p;
    },
    menuItems: async (d, part) =>
      part === 1
        ? readJson<MenuItemsFile>(join(dir, `${d}.menu_items.json`))
        : null,
    menuItemParts: async (d) =>
      existsSync(join(dir, `${d}.menu_items.json`)) ? 1 : 0,
  };
}
