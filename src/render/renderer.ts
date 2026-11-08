// Boot, loop, resize, visibility (HANDOFF §3). One GPU context for the life of the page.

import { AgXToneMapping, WebGPURenderer } from 'three/webgpu';
import { STAGES, progressToStage, type StagePoint } from '../time/stages.ts';
import { $progress, $quality, $reducedMotion, $rendererStatus, $sceneInfo, $stats } from '../state/store.ts';
import { createAssetLoader, type AssetLoader } from './assets.ts';
import { Compositor } from './Compositor.ts';
import { createGlobalUniforms, type GlobalUniforms } from './globals.ts';
import { FrameMonitor, guessTier, lowerTier, tier, tierFromProbe, type Backend, type QualityTier, type TierName } from './quality.ts';
import { SceneManager, type SceneEntry } from './SceneManager.ts';
import { makePlaceholder } from '../scenes/_placeholder/index.ts';
import type { RenderContext } from '../scenes/types.ts';
import { LabelLayer } from '../shared/gfx/labels.ts';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** HTML layer for 3D-anchored labels. */
  labelRoot?: HTMLElement;
  /** Force the WebGL2 backend (also via ?webgl=1). */
  forceWebGL?: boolean;
  /** Dev: render one scene at a fixed local instead of following the scroll. */
  single?: { sceneId: string; local: number; paused?: boolean };
  /** Skip the 1 s probe (dev, screenshots). */
  skipProbe?: boolean;
  tier?: TierName;
}

export interface Engine {
  renderer: WebGPURenderer;
  backend: Backend;
  quality: QualityTier;
  manager: SceneManager;
  globals: GlobalUniforms;
  assets: AssetLoader;
  setSingle(single: EngineOptions['single']): void;
  frames(): number;
  setTier(name: TierName, auto: boolean): Promise<void>;
  dispose(): void;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

export async function createEngine(opts: EngineOptions): Promise<Engine | null> {
  const { canvas } = opts;
  const params = new URLSearchParams(location.search);
  const forceWebGL = opts.forceWebGL ?? params.get('webgl') === '1';
  const renderer = new WebGPURenderer({ canvas, antialias: false, alpha: false, forceWebGL, powerPreference: 'high-performance' });
  try {
    await renderer.init();
  } catch (err) {
    console.warn('[renderer] no WebGPU or WebGL2; using stills', err);
    $rendererStatus.set('fallback');
    return null;
  }
  const backend: Backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  renderer.toneMapping = AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 1);

  const globals = createGlobalUniforms();
  const assets = createAssetLoader();
  const tierParam = (params.get('tier') as TierName | null) ?? opts.tier ?? null;
  let quality = tier(tierParam ?? guessTier(backend), backend, !tierParam);
  const labels = opts.labelRoot ? new LabelLayer(opts.labelRoot) : null;

  let width = 1;
  let height = 1;
  let dpr = 1;
  let compositor: Compositor | null = null;
  let manager: SceneManager | null = null;
  const applySize = () => {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, quality.maxDpr);
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    width = Math.max(1, Math.floor(w * dpr * quality.renderScale));
    height = Math.max(1, Math.floor(h * dpr * quality.renderScale));
    globals.setResolution(width, height);
    compositor?.setSize(width, height);
    manager?.resize(width, height, dpr);
    labels?.measure();
  };
  applySize();

  const ctx: RenderContext = { renderer, globals, quality, assets };
  compositor = new Compositor(renderer, globals);
  manager = new SceneManager(ctx);
  applySize();

  // ── Quality probe: 1 s of a heavy placeholder at the chosen resolution.
  if (quality.auto && !opts.skipProbe && !opts.single && params.get('probe') !== '0') {
    const probe = makePlaceholder({ id: '_probe', probe: true });
    const tmp = manager.load('_placeholder');
    await tmp.promise;
    await probe.init(ctx);
    probe.resize(width, height, dpr);
    globals.update(0.5, 0);
    const times: number[] = [];
    const t0 = performance.now();
    let last = t0;
    await new Promise<void>((resolve) => {
      renderer.setAnimationLoop(() => {
        const now = performance.now();
        times.push(now - last);
        last = now;
        probe.update(0.5, 0.016, (now - t0) / 1000);
        probe.render(tmp.target);
        compositor!.render(tmp.target.texture, null, 1, 'none', 0);
        if (now - t0 > 1000) {
          renderer.setAnimationLoop(null);
          resolve();
        }
      });
    });
    probe.dispose();
    manager.unload('_placeholder');
    const sorted = times.slice(5).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 16;
    const next = tierFromProbe(quality.name, median);
    console.info(`[quality] backend ${backend}, guess ${quality.name}, probe median ${median.toFixed(1)} ms → ${next}`);
    if (next !== quality.name) {
      quality = tier(next, backend, true);
      manager.setContext({ quality });
      applySize();
    }
  }
  $quality.set(quality);

  // ── Loop ──────────────────────────────────────────────────────────────────
  const sp: StagePoint = progressToStage(0);
  const monitor = new FrameMonitor();
  let single = opts.single ?? null;
  let lastNow = performance.now();
  let elapsed = 0;
  let prevProgress = $progress.get();
  let direction = 1;
  let frames = 0;
  let statsAt = 0;
  let statFrames = 0;
  let lastSceneId = '';
  let changingTier = false;

  const publishInfo = (e: SceneEntry | null) => {
    const s = e?.scene;
    if (!s || s.id === lastSceneId) return;
    lastSceneId = s.id;
    $sceneInfo.set({ sceneId: s.id, status: s.status, statusNote: s.statusNote });
  };

  const fadeFor = (e: SceneEntry | null, nowS: number) => (e ? smooth(Math.min(1, (nowS - e.readyAt) / 0.6)) : 0);

  const frame = () => {
    const now = performance.now();
    const dtMs = Math.min(100, now - lastNow);
    lastNow = now;
    const dt = dtMs / 1000;
    const nowS = now / 1000;
    const reduced = $reducedMotion.get();
    if (!reduced) elapsed += dt;
    frames++;
    labels?.begin();

    if (single) {
      const entry = manager!.only(single.sceneId);
      globals.update(single.local, elapsed);
      if (entry.scene && entry.status !== 'loading') {
        entry.scene.update(single.local, single.paused ? 0 : dt, elapsed);
        entry.scene.render(entry.target);
        publishInfo(entry);
        if (entry.scene.labels) labels?.draw(entry.scene.labels, 1);
      }
      compositor!.render(entry.scene ? entry.target.texture : null, null, 1, 'none', entry.scene ? 1 : 0);
    } else {
      const p = $progress.get();
      if (p !== prevProgress) direction = p > prevProgress ? 1 : -1;
      prevProgress = p;
      progressToStage(p, sp);
      const i = sp.index;
      const st = sp.stage;
      manager!.sync(i, sp.local, direction);

      const prev = STAGES[i - 1];
      const inTransition = !!prev && prev.sceneId !== st.sceneId && sp.local < st.transitionSpan;
      const mixT = inTransition ? smooth(sp.local / st.transitionSpan) : 1;

      const incoming = manager!.ready(st.sceneId);
      const outgoing = inTransition ? manager!.ready(prev!.sceneId) : null;

      if (reduced) {
        // One still per stage at local = 0.5, held; transitions are plain crossfades.
        for (const e of [incoming, outgoing]) {
          if (!e?.scene) continue;
          const key = `${e.id}:${e.target.width}x${e.target.height}`;
          if (e.heldKey === key) continue;
          globals.update(0.5, 0);
          e.scene.update(0.5, 0, 0);
          e.scene.render(e.target);
          e.heldKey = key;
        }
        globals.update(sp.local, 0);
      } else {
        if (outgoing?.scene) {
          // The outgoing scene holds its final, calm frame.
          globals.update(1, elapsed);
          outgoing.scene.update(1, dt, elapsed);
          outgoing.scene.render(outgoing.target);
        }
        globals.update(sp.local, elapsed);
        if (incoming?.scene) {
          incoming.scene.update(sp.local, dt, elapsed);
          incoming.scene.render(incoming.target);
        }
      }
      publishInfo(mixT > 0.5 || !outgoing ? incoming : outgoing);
      const fade = Math.max(fadeFor(incoming, nowS), outgoing ? 1 : 0);
      if (labels) {
        // Labels don't follow the transition's distortion: clear the outgoing set early, bring the incoming set in late.
        const outW = Math.max(0, 1 - mixT * 2.5);
        const inW = outgoing ? smooth(Math.min(1, Math.max(0, (mixT - 0.45) / 0.55))) : 1;
        if (outgoing?.scene?.labels) labels.draw(outgoing.scene.labels, outW);
        if (incoming?.scene?.labels) labels.draw(incoming.scene.labels, inW * fadeFor(incoming, nowS));
      }
      compositor!.render(
        incoming?.scene ? incoming.target.texture : null,
        outgoing?.scene ? outgoing.target.texture : null,
        incoming?.scene ? mixT : 0,
        reduced ? 'fade' : st.transitionIn,
        incoming?.scene ? fade : outgoing ? 1 : 0,
      );
    }
    labels?.end();

    // Stats + dynamic quality.
    statFrames++;
    if (now - statsAt > 500) {
      const info = renderer.info as unknown as { memory: { geometries: number; textures: number }; programs?: unknown[] };
      $stats.set({
        fps: (statFrames * 1000) / (now - statsAt),
        frameMs: monitor.median(),
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: Array.isArray(info.programs) ? info.programs.length : 0,
      });
      statsAt = now;
      statFrames = 0;
    }
    const shouldDrop = monitor.push(dtMs, nowS);
    if (quality.auto && !single && !changingTier && shouldDrop) {
      const lower = lowerTier(quality.name);
      if (lower) {
        console.info(`[quality] median frame > 22 ms for 3 s: ${quality.name} → ${lower}`);
        void engine.setTier(lower, true);
      }
    }
  };

  // ── Resize + visibility ─────────────────────────────────────────────────────
  const ro = new ResizeObserver(() => applySize());
  ro.observe(canvas);
  let visible = !document.hidden;
  let intersecting = true;
  const updateLoop = () => {
    if (visible && intersecting) {
      lastNow = performance.now();
      renderer.setAnimationLoop(frame);
    } else renderer.setAnimationLoop(null);
  };
  const onVis = () => {
    visible = !document.hidden;
    updateLoop();
  };
  document.addEventListener('visibilitychange', onVis);
  const io = new IntersectionObserver((entries) => {
    intersecting = entries.some((e) => e.isIntersecting);
    updateLoop();
  });
  io.observe(canvas);

  const engine: Engine = {
    renderer,
    backend,
    get quality() {
      return quality;
    },
    manager: manager!,
    globals,
    assets,
    setSingle(s) {
      single = s ?? null;
    },
    frames: () => frames,
    async setTier(name, auto) {
      if (name === quality.name && auto === quality.auto) return;
      changingTier = true;
      quality = tier(name, backend, auto);
      manager!.disposeAll();
      manager!.setContext({ quality });
      applySize();
      $quality.set(quality);
      monitor.reset();
      changingTier = false;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      labels?.clear();
      manager!.dispose();
      compositor!.dispose();
      globals.dispose();
      assets.dispose();
      renderer.dispose();
    },
  };

  $rendererStatus.set('ready');
  updateLoop();
  return engine;
}
