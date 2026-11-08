// Coast data for the renderer: the baked heightfield and stations of a region (public/data/bay/), and the derived
// fields from src/coast/bake.ts computed once per session in a Web Worker. Both are cached at module level, so a
// scene that is unloaded and reloaded (scroll back, leak test) pays only for its GPU resources.

import { decodeHalfArray, encodeHalfArray, unpackHalfBits, type Heightfield, type HeightfieldMeta } from '../../coast/heightfield.ts';
import type { BayStation } from '../../coast/tidefield.ts';
import { bakeCoast, type BakeOptions, type CoastBake } from '../../coast/bake.ts';
import type { AssetLoader } from '../../render/assets.ts';

export interface CoastSource {
  /** Cache key (region id, or a finale place key). */
  id: string;
  name: string;
  hf: Heightfield;
  /** The heights as IEEE half-float bits (ready for a HalfFloat texture). */
  halfBits: Uint16Array;
  stations: BayStation[];
}

export interface StationsDoc {
  region: string;
  datum: string;
  stations: BayStation[];
}

const BASE = '/data/bay/';
const sources = new Map<string, Promise<CoastSource>>();
const bakes = new Map<string, Promise<CoastBake>>();
const MAX_BAKES = 4;

async function inflate(buf: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A source from a heightfield already in memory (the finale's live tiles): id is the bake cache key. */
export function coastSourceFrom(id: string, name: string, hf: Heightfield, stations: BayStation[]): CoastSource {
  return { id, name, hf, halfBits: encodeHalfArray(hf.data), stations };
}

/** Load a baked region ('sf', 'nyc'). */
export function loadCoastSource(assets: AssetLoader, region: string): Promise<CoastSource> {
  let p = sources.get(region);
  if (!p) {
    p = (async () => {
      const [meta, bin, doc] = await Promise.all([
        assets.json<HeightfieldMeta>(`${BASE}${region}-terrain.json`),
        assets.binary(`${BASE}${region}-terrain.bin`),
        assets.json<StationsDoc>(`${BASE}${region}-stations.json`),
      ]);
      const halfBits = unpackHalfBits(await inflate(bin));
      if (halfBits.length !== meta.nx * meta.ny) throw new Error(`${region}: terrain size mismatch`);
      const hf: Heightfield = { nx: meta.nx, ny: meta.ny, bbox: meta.bbox, data: decodeHalfArray(halfBits) };
      return { id: region, name: meta.region, hf, halfBits, stations: doc.stations };
    })();
    sources.set(region, p);
    p.catch(() => sources.delete(region));
  }
  return p;
}

/** Derived fields, computed in a worker (main-thread fallback), cached per source + options. */
export function bakeSource(src: CoastSource, opts: BakeOptions): Promise<CoastBake> {
  const key = `${src.id}|${JSON.stringify(opts)}`;
  let p = bakes.get(key);
  if (p) {
    // Most recently used last (Map keeps insertion order).
    bakes.delete(key);
    bakes.set(key, p);
    return p;
  }
  p = runBake(src, opts);
  bakes.set(key, p);
  p.catch(() => bakes.delete(key));
  // Keep the last few places (the finale visits many); the baked regions are re-derived if evicted.
  while (bakes.size > MAX_BAKES) bakes.delete(bakes.keys().next().value!);
  return p;
}

function runBake(src: CoastSource, opts: BakeOptions): Promise<CoastBake> {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return Promise.resolve(bakeCoast(src.hf, src.stations, opts));
  }
  return new Promise<CoastBake>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<{ ok: true; bake: CoastBake } | { ok: false; error: string }>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.bake);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      // A worker that cannot start (CSP, old browser) falls back to the main thread.
      try {
        resolve(bakeCoast(src.hf, src.stations, opts));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(e.message)));
      }
    };
    worker.postMessage({ hf: src.hf, stations: src.stations, opts });
  });
}
