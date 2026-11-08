// Shared state (nanostores). The single source of truth is $progress → (stage, local) (HANDOFF §3).

import { atom, computed, map, onMount, type ReadableAtom } from 'nanostores';
import { progressToStage } from '../time/stages.ts';
import type { QualityTier } from '../render/quality.ts';
import type { Status } from '../time/stages.ts';

/** 0–1 page scroll through the stages. */
export const $progress = atom(0);

export interface StageState {
  stageId: string;
  index: number;
  sceneId: string;
  local: number;
}

export const $stage: ReadableAtom<StageState> = computed($progress, (p) => {
  const sp = progressToStage(p);
  return { stageId: sp.stage.id, index: sp.index, sceneId: sp.stage.sceneId, local: sp.local };
});

/** Stage id only; changes rarely (announcements, HUD switching). */
export const $stageId: ReadableAtom<string> = computed($stage, (s) => s.stageId);

export const $quality = atom<QualityTier | null>(null);

function mediaAtom(query: string): ReadableAtom<boolean> {
  const a = atom(false);
  onMount(a, () => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(query);
    a.set(mq.matches);
    const on = (e: MediaQueryListEvent) => a.set(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  return a;
}

export const $reducedMotion: ReadableAtom<boolean> = mediaAtom('(prefers-reduced-motion: reduce)');

export type RendererStatus = 'booting' | 'ready' | 'fallback' | 'error';
export const $rendererStatus = atom<RendererStatus>('booting');

/** Status of the scene on screen, published by the engine. */
export const $sceneInfo = atom<{ sceneId: string; status: Status; statusNote: string } | null>(null);

/** Per-scene load status (dev overlay and fallbacks). */
export const $sceneStatus = map<Record<string, 'loading' | 'ready' | 'failed'>>({});

/** Frame statistics (dev only). */
export const $stats = atom({ fps: 0, frameMs: 0, geometries: 0, textures: 0, programs: 0 });
