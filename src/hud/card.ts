// Helpers for HUD cards: a rAF-batched subscription to the stage, and show/hide.

import { $stage, type StageState } from '../state/store.ts';

export function onStage(draw: (s: StageState) => void): void {
  let pending = false;
  $stage.subscribe(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      draw($stage.get());
    });
  });
}

export function showCard(el: HTMLElement, on: boolean): void {
  if (el.classList.contains('is-on') !== on) el.classList.toggle('is-on', on);
}
