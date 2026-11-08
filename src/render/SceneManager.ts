// Loads, preloads and disposes scenes (HANDOFF §10.3). Keeps active + previous + next initialised.
// Each live scene owns a HalfFloat render target (§10.4). A scene that fails to init is replaced by its still.

import {
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  SRGBColorSpace,
  type Texture,
} from 'three/webgpu';
import { texture, uv, vec4 } from 'three/tsl';
import { SCENES } from '../scenes/registry.ts';
import type { BlockScene, RenderContext } from '../scenes/types.ts';
import { $sceneStatus } from '../state/store.ts';
import { STAGES } from '../time/stages.ts';

export interface SceneEntry {
  id: string;
  scene: BlockScene | null;
  status: 'loading' | 'ready' | 'failed';
  target: RenderTarget;
  /** Seconds since ready (for fade-in). */
  readyAt: number;
  /** Reduced-motion: key of the frame already rendered into target. */
  heldKey: string | null;
  promise: Promise<void>;
}

export class SceneManager {
  private readonly entries = new Map<string, SceneEntry>();
  private width = 1;
  private height = 1;
  private dpr = 1;
  private disposed = false;
  private syncIndex = -1;
  private syncSince = 0;
  private readonly keep = new Set<string>();
  private readonly drop: string[] = [];
  constructor(private readonly ctx: RenderContext) {}

  setContext(patch: Partial<RenderContext>): void {
    Object.assign(this.ctx, patch);
  }

  get(id: string): SceneEntry | undefined {
    return this.entries.get(id);
  }

  /** The entry if it is ready to render. */
  ready(id: string): SceneEntry | null {
    const e = this.entries.get(id);
    return e && e.scene && e.status !== 'loading' ? e : null;
  }

  load(id: string, now = performance.now() / 1000): SceneEntry {
    const hit = this.entries.get(id);
    if (hit) return hit;
    const target = new RenderTarget(Math.max(1, this.width), Math.max(1, this.height), {
      type: HalfFloatType,
      depthBuffer: true,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    const entry: SceneEntry = {
      id,
      scene: null,
      status: 'loading',
      target,
      readyAt: now,
      heldKey: null,
      promise: Promise.resolve(),
    };
    $sceneStatus.setKey(id, 'loading');
    entry.promise = (async () => {
      try {
        const loader = SCENES[id];
        if (!loader) throw new Error(`unknown scene ${id}`);
        const mod = await loader();
        const scene = mod.default();
        await scene.init(this.ctx);
        if (this.disposed || this.entries.get(id) !== entry) {
          scene.dispose();
          return;
        }
        scene.resize(this.width, this.height, this.dpr);
        entry.scene = scene;
        entry.status = 'ready';
        entry.readyAt = performance.now() / 1000;
        $sceneStatus.setKey(id, 'ready');
      } catch (err) {
        console.error(`[scene ${id}] init failed`, err);
        if (this.entries.get(id) !== entry) return;
        entry.scene = await createStillScene(this.ctx, id).catch(() => null);
        entry.scene?.resize(this.width, this.height, this.dpr);
        entry.status = 'failed';
        entry.readyAt = performance.now() / 1000;
        $sceneStatus.setKey(id, 'failed');
      }
    })();
    this.entries.set(id, entry);
    return entry;
  }

  unload(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    $sceneStatus.setKey(id, undefined as unknown as 'ready'); // remove key
    try {
      e.scene?.dispose();
    } catch (err) {
      console.error(`[scene ${id}] dispose failed`, err);
    }
    e.target.dispose();
  }

  /**
   * Keep {previous, active, next} chapter scenes. Preload next when local > 0.6 (forward), previous when
   * local < 0.4 (backward). The previous scene is also needed for the incoming transition.
   */
  sync(chapterIndex: number, local: number, direction: number, nowS = performance.now() / 1000): void {
    const cur = STAGES[chapterIndex]!;
    const prev = STAGES[chapterIndex - 1];
    const next = STAGES[chapterIndex + 1];
    // Dwell: during a fast flight (a nav jump across many chapters) do not initialise every scene we pass.
    if (chapterIndex !== this.syncIndex) {
      this.syncIndex = chapterIndex;
      this.syncSince = nowS;
    }
    const settled = nowS - this.syncSince > 0.15 || this.entries.has(cur.sceneId);
    const keep = this.keep;
    keep.clear();
    keep.add(cur.sceneId);
    if (settled) this.load(cur.sceneId);
    const wantPrev = local < cur.transitionSpan || (direction < 0 && local < 0.4);
    if (prev && (wantPrev || this.entries.has(prev.sceneId))) {
      keep.add(prev.sceneId);
      if (wantPrev && settled) this.load(prev.sceneId);
    }
    const wantNext = direction >= 0 && local > 0.6;
    if (next && (wantNext || this.entries.has(next.sceneId))) {
      keep.add(next.sceneId);
      if (wantNext && settled) this.load(next.sceneId);
    }
    if (this.entries.size > keep.size) {
      this.drop.length = 0;
      for (const id of this.entries.keys()) if (!keep.has(id)) this.drop.push(id);
      for (const id of this.drop) this.unload(id);
    }
  }

  /** Single-scene mode (dev route): keep only this one. */
  only(id: string): SceneEntry {
    for (const k of [...this.entries.keys()]) if (k !== id) this.unload(k);
    return this.load(id);
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    for (const e of this.entries.values()) {
      e.target.setSize(width, height);
      e.heldKey = null;
      e.scene?.resize(width, height, dpr);
    }
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.unload(id);
  }

  dispose(): void {
    this.disposed = true;
    this.disposeAll();
  }

  get liveIds(): string[] {
    return [...this.entries.keys()];
  }
}

/** Fallback: the chapter's still image as a full-frame quad (§10.3, §10.6). */
async function createStillScene(ctx: RenderContext, sceneId: string): Promise<BlockScene> {
  const url = `/stills/${sceneId}.webp`;
  let tex: Texture | null = null;
  try {
    tex = await ctx.assets.texture(url, { colorSpace: SRGBColorSpace, mipmaps: false });
  } catch {
    tex = null;
  }
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new MeshBasicNodeMaterial();
  mat.colorNode = tex ? texture(tex, uv()) : vec4(0.02, 0.02, 0.04, 1);
  const quad = new Mesh(new PlaneGeometry(2, 2), mat);
  scene.add(quad);
  return {
    id: `${sceneId}:still`,
    status: STAGES.find((st) => st.sceneId === sceneId)?.status ?? 'metaphor',
    statusNote: 'Still image shown because this scene could not start on your device.',
    async init() {},
    update() {},
    render(target) {
      ctx.renderer.setRenderTarget(target);
      ctx.renderer.render(scene, camera);
    },
    resize() {},
    dispose() {
      quad.geometry.dispose();
      mat.dispose();
      if (tex) ctx.assets.release(url);
    },
  };
}
