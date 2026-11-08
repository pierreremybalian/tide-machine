// Live narration inputs for stages whose numbers change without scrolling (the finale's chosen place): bump
// $narrationTick to redraw the dual clock, and set a stage's status chip from $statusOverride.

import { atom } from 'nanostores';
import type { Status } from '../time/stages.ts';

export const $narrationTick = atom(0);
export const $statusOverride = atom<Partial<Record<string, Status>>>({});

export function refreshNarration(): void {
  $narrationTick.set($narrationTick.get() + 1);
}
