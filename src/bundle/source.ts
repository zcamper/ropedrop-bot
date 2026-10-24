// Read side of the bundle. One BundleSource per request: files are read
// from Redis and parsed lazily, each at most once per request.

import type {
  BundleSource,
  Common,
  Core,
  DAW,
  Dest,
  Events,
  LL,
  MenuFile,
  Posts,
} from '../bot/types.js';
import { K, type GenMeta, type KV } from './sync.js';

type Layout = Pick<
  GenMeta,
  'generation' | 'generated_at' | 'common' | 'destinations'
>;

/** A bundle generation reachable through `read(path) -> JSON text`. */
export class LayoutSource implements BundleSource {
  private cache = new Map<string, Promise<unknown>>();

  constructor(
    private layout: Layout,
    private read: (path: string) => Promise<string>
  ) {}

  async generation(): Promise<string> {
    return this.layout.generation;
  }

  generatedAt(): string {
    return this.layout.generated_at;
  }

  private json<T>(path: string | undefined | null): Promise<T | null> {
    if (!path) return Promise.resolve(null);
    let p = this.cache.get(path);
    if (!p) {
      p = this.read(path).then((t) => JSON.parse(t) as unknown);
      this.cache.set(path, p);
    }
    return p as Promise<T>;
  }

  private files(dest: Dest) {
    return this.layout.destinations[dest]?.files;
  }

  async common(): Promise<Common> {
    const c = await this.json<Common>(this.layout.common);
    if (!c) throw new Error('bundle has no common.json');
    return c;
  }

  core(dest: Dest): Promise<Core | null> {
    return this.json<Core>(this.files(dest)?.core);
  }

  events(dest: Dest): Promise<Events | null> {
    return this.json<Events>(this.files(dest)?.events);
  }

  ll(dest: Dest): Promise<LL | null> {
    return this.json<LL>(this.files(dest)?.ll);
  }

  daw(dest: Dest): Promise<DAW | null> {
    return this.json<DAW>(this.files(dest)?.daw);
  }

  menus(dest: Dest, part: number): Promise<MenuFile | null> {
    return this.json<MenuFile>(this.files(dest)?.menus?.[part - 1]);
  }

  async menuParts(dest: Dest): Promise<number> {
    return this.files(dest)?.menus?.length ?? 0;
  }

  posts(dest: Dest): Promise<Posts | null> {
    return this.json<Posts>(this.files(dest)?.posts);
  }
}

async function readBlob(kv: KV, meta: GenMeta, path: string): Promise<string> {
  const f = meta.files[path];
  if (!f)
    throw new Error(`bundle file ${path} not in generation ${meta.generation}`);
  const parts: string[] = [];
  for (let i = 0; i < f.chunks; i++) {
    const v = await kv.get(K.chunk(f.sha256, i));
    if (v === undefined || v === null)
      throw new Error(`bundle chunk missing: ${path} #${i}`);
    parts.push(v);
  }
  const text = parts.join('');
  if (text.length !== f.chars)
    throw new Error(`bundle file ${path} is truncated`);
  return text;
}

async function loadMeta(kv: KV, key: string): Promise<GenMeta | null> {
  const gen = await kv.get(key);
  if (!gen) return null;
  const raw = await kv.get(K.meta(gen));
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as GenMeta;
    return m.complete ? m : null;
  } catch {
    return null;
  }
}

/**
 * The current generation from Redis, falling back to the previous one when
 * the current pointer or any of its files can't be read. Returns null when
 * no generation has been stored yet.
 */
export async function openRedisBundle(kv: KV): Promise<LayoutSource | null> {
  const current = await loadMeta(kv, K.current);
  const previous = await loadMeta(kv, K.previous);
  const primary = current ?? previous;
  if (!primary) return null;
  const fallback =
    current && previous && previous.generation !== current.generation
      ? previous
      : null;
  const read = async (path: string): Promise<string> => {
    try {
      return await readBlob(kv, primary, path);
    } catch (err) {
      if (!fallback) throw err;
      // Same kind of file in the previous generation (paths differ per generation).
      const want = primary.files[path];
      const alt = Object.entries(fallback.files).find(
        ([p, f]) =>
          want &&
          f.kind === want.kind &&
          f.dest === want.dest &&
          samePart(p, path)
      );
      if (!alt) throw err;
      console.warn(
        `[bundle] ${path} unreadable in ${primary.generation}; using ${fallback.generation}`
      );
      return readBlob(kv, fallback, alt[0]);
    }
  };
  return new LayoutSource(primary, read);
}

function samePart(a: string, b: string): boolean {
  const tail = (p: string) => p.split('/').slice(-1)[0];
  return tail(a) === tail(b);
}
