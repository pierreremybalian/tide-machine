// Asset loader shared by scenes: caches by URL, reference-counted so dispose() frees GPU memory.

import { LinearFilter, SRGBColorSpace, Texture, TextureLoader, type ColorSpace } from 'three/webgpu';

export interface AssetLoader {
  texture(url: string, opts?: { colorSpace?: ColorSpace; mipmaps?: boolean }): Promise<Texture>;
  binary(url: string): Promise<ArrayBuffer>;
  json<T>(url: string): Promise<T>;
  release(url: string): void;
  dispose(): void;
}

export function createAssetLoader(): AssetLoader {
  const textures = new Map<string, { promise: Promise<Texture>; refs: number }>();
  const blobs = new Map<string, Promise<ArrayBuffer>>();
  const loader = new TextureLoader();
  return {
    texture(url, opts = {}) {
      const hit = textures.get(url);
      if (hit) {
        hit.refs++;
        return hit.promise;
      }
      const promise = loader.loadAsync(url).then((tex) => {
        tex.colorSpace = opts.colorSpace ?? SRGBColorSpace;
        tex.generateMipmaps = opts.mipmaps ?? true;
        if (!tex.generateMipmaps) tex.minFilter = LinearFilter;
        tex.needsUpdate = true;
        return tex;
      });
      textures.set(url, { promise, refs: 1 });
      promise.catch(() => textures.delete(url));
      return promise;
    },
    binary(url) {
      let p = blobs.get(url);
      if (!p) {
        p = fetch(url).then((r) => {
          if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
          return r.arrayBuffer();
        });
        blobs.set(url, p);
        p.catch(() => blobs.delete(url));
      }
      return p;
    },
    async json<T>(url: string) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return (await r.json()) as T;
    },
    release(url) {
      const hit = textures.get(url);
      if (!hit) return;
      if (--hit.refs <= 0) {
        textures.delete(url);
        void hit.promise.then((t) => t.dispose());
      }
    },
    dispose() {
      for (const { promise } of textures.values()) void promise.then((t) => t.dispose());
      textures.clear();
      blobs.clear();
    },
  };
}
