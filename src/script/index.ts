// Stage scripts (HANDOFF §3): pure functions of `local` shared by scenes, narration and the HUD, so a number on
// screen and the geometry it describes cannot disagree. Each stage module registers its status note (what kind of
// claim it makes, what it exaggerates) and `readouts(local)` for the dual clock; scenes import their own module.

export type Tone = 'a' | 'b' | 'both' | 'light' | 'plain' | 'warm' | 'mute';

export interface Readout {
  label: string;
  value: string;
  tone: Tone;
}

export interface StageMeta {
  /** One sentence shown on the stage's intro card. */
  note: string;
  readouts(local: number): Readout[];
  /** Panel dividers drawn by the HUD (0–1 opacity): v = centre vertical line (diptych), h = centre horizontal (quadtych). */
  dividers?(local: number): { v: number; h: number };
}

const REGISTRY: Record<string, StageMeta> = {};

export function registerStage(stageId: string, meta: StageMeta): StageMeta {
  REGISTRY[stageId] = meta;
  return meta;
}

export function readouts(stageId: string, local: number): Readout[] {
  return REGISTRY[stageId]?.readouts(local) ?? [];
}

export function stageNote(stageId: string): string {
  return REGISTRY[stageId]?.note ?? '';
}

export function stageDividers(stageId: string, local: number): { v: number; h: number } {
  return REGISTRY[stageId]?.dividers?.(local) ?? { v: 0, h: 0 };
}
