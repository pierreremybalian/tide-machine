// Guided narration behaviour: shows the caption scheduled for the current progress, keeps the stage label and the
// dual clock current, and announces stage changes politely. All DOM writes are batched to one rAF.

import { $progress, $stage } from '../state/store.ts';
import { STAGES } from '../time/stages.ts';
import { STATUS_LABEL } from '../data/site.ts';
import { supHtml } from '../lib/sup.ts';
import { readouts } from '../script/index.ts';
import '../script/all.ts';
import { HERO_END, captionAt } from './schedule.ts';

export function initNarration(root: HTMLElement): void {
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const titles = JSON.parse(root.dataset.titles ?? '[]') as string[];
  const caps = [...root.querySelectorAll<HTMLElement>('[data-cap]')];
  const starts = Float64Array.from(caps, (c) => Number(c.dataset.start));
  const bar = q<HTMLElement>('[data-bar]');
  const stageNum = q<HTMLElement>('[data-stage-num]');
  const stageName = q<HTMLElement>('[data-stage-name]');
  const chip = q<HTMLElement>('[data-acc-chip]');
  const chipLabel = q<HTMLElement>('[data-acc-label]');
  const dual = q<HTMLElement>('[data-dual]');
  const live = q<HTMLElement>('[data-live]');
  const total = String(STAGES.length).padStart(2, '0');

  let current = -1;
  let lastStage = -1;
  let lastDual = '';
  let pending = false;

  const draw = () => {
    pending = false;
    const p = $progress.get();
    const s = $stage.get();
    root.classList.toggle('is-hero', p < HERO_END * 0.6);
    bar.style.setProperty('--p', String(p));

    const idx = p < HERO_END * 0.6 ? -1 : captionAt(starts, p);
    if (idx !== current) {
      caps[current]?.classList.remove('is-on');
      caps[idx]?.classList.add('is-on');
      current = idx;
    }

    if (s.index !== lastStage) {
      const first = lastStage === -1;
      lastStage = s.index;
      const st = STAGES[s.index]!;
      stageNum.textContent = `${String(s.index + 1).padStart(2, '0')} / ${total}`;
      stageName.textContent = titles[s.index] ?? '';
      chip.dataset.st = st.status;
      chipLabel.textContent = STATUS_LABEL[st.status];
      if (!first) live.textContent = `Stage ${s.index + 1} of ${STAGES.length}: ${titles[s.index] ?? ''}. ${STATUS_LABEL[st.status]}.`;
    }

    // Dual clock: rows from the stage script (rebuilt only when the text changes).
    const rows = readouts(s.stageId, s.local);
    const key = rows.map((r) => `${r.tone}|${r.label}|${r.value}`).join('¦');
    if (key !== lastDual) {
      lastDual = key;
      dual.innerHTML = rows
        .map((r) => `<dt data-tone="${r.tone}"><i></i>${r.label}</dt><dd data-tone="${r.tone}">${supHtml(r.value)}</dd>`)
        .join('');
    }
  };
  const schedule = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(draw);
    }
  };
  $progress.subscribe(schedule);

}
