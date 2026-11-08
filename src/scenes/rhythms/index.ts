// Stage 6 · Many rhythms — the constituent spectrum of San Francisco's tide (HANDOFF §7, §9 "constituent spectrum").
// Every constituent is a glowing line standing at its speed (degrees per hour, fixed by astronomy) with a height equal
// to NOAA's amplitude at San Francisco, coloured by family. The view zooms through the families, singling out the
// rhythms whose causes the narration names, then pulls back to make room for the table card.

import { PerspectiveCamera, Scene, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createKit } from '../../shared/gfx/kit.ts';
import { createEvents, type Events } from '../../shared/gfx/events.ts';
import { LabelSet, type LabelSpec, type Tone } from '../../shared/gfx/labels.ts';
import { PAL, type RGB } from '../../shared/gfx/palette.ts';
import { createLines, type LineSpec, type Lines } from './lines.ts';
import {
  axisOf,
  BEATS,
  cm,
  hmPeriod,
  LINES,
  rhythms,
  rhythmsState,
  VIEWS,
  type RhythmsState,
} from '../../script/rhythms.ts';
import type { Family } from '../../tides/constituents.ts';

const FAMILY: Record<Family, RGB> = {
  semidiurnal: [0.5, 0.82, 1.0],
  diurnal: PAL.a,
  long: PAL.light,
  shallow: PAL.green,
  terdiurnal: PAL.green,
};
const TONE: Record<Family, Tone> = {
  semidiurnal: 'b',
  diurnal: 'a',
  long: 'light',
  shallow: 'plain',
  terdiurnal: 'plain',
};
const C = { grid: [0.36, 0.42, 0.62] as RGB, faint: [0.22, 0.26, 0.4] as RGB };

const params = {
  fov: 30,
  /** Names shown in the overview (the rest only when their family is zoomed). */
  overviewNames: ['M2', 'K1', 'O1', 'S2', 'N2', 'P1', 'SA', 'M4'],
  grid: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
};

interface Layout {
  x0: number;
  x1: number;
  /** Closing view (room for the table card on the right). */
  tx0: number;
  tx1: number;
  base: number;
  k: number;
  portrait: boolean;
}

/** Break a sentence into lines of at most `n` characters. */
function wrap(text: string, n: number): string {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(' ')) {
    if (line && (line + ' ' + w).length > n) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join('<br>');
}

export default function rhythmsScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const camera = new PerspectiveCamera(params.fov, 16 / 9, 0.1, 50);
  const kit = createKit();
  const disposers: (() => void)[] = [];
  let lines: Lines;
  let dots: Events;
  let lay = layout(16 / 9);
  let state: RhythmsState = rhythmsState(0);
  const D = 1 / Math.tan((params.fov / 2) * (Math.PI / 180));
  const focusAll = new Set(BEATS.flatMap((b) => b.focus));
  const families = [
    { id: 'fLong', text: 'slow: weeks to a year', short: 'slow', at: 0.55, tone: 'light' as const },
    { id: 'fDiurnal', text: 'once a day', short: '1/day', at: 14.5, tone: 'a' as const },
    { id: 'fSemi', text: 'twice a day', short: '2/day', at: 29, tone: 'b' as const },
    { id: 'fShallow', text: '3 to 8 a day: shallow water', short: 'shallow', at: 51, tone: 'plain' as const },
  ];

  const focusText = (name: string, portrait: boolean) => {
    const l = LINES.find((x) => x.name === name)!;
    const head = `<b>${l.label}</b> · ${hmPeriod(l.period)} · ${cm(l.H)}`;
    return `${head}<br><span style="color:var(--color-fog);font-weight:400;font-size:0.92em">${wrap(l.c.about, portrait ? 30 : 40)}</span>`;
  };

  const labelSpecs: LabelSpec[] = [
    ...LINES.map((l) => ({
      id: `n${l.name}`,
      text: l.label,
      tone: TONE[l.family],
      side: 'above' as const,
      size: 'md' as const,
    })),
    ...[...focusAll].map((name) => {
      const l = LINES.find((x) => x.name === name)!;
      return {
        id: `f${name}`,
        text: focusText(name, false),
        tone: TONE[l.family],
        side: 'above' as const,
        size: 'md' as const,
      };
    }),
    ...families.map((f) => ({
      id: f.id,
      text: f.text,
      tone: f.tone,
      side: 'below' as const,
      size: 'sm' as const,
    })),
    ...params.grid.map((m) => ({
      id: `g${m}`,
      text: `${m.toFixed(1)} m`,
      tone: 'mute' as const,
      side: 'left' as const,
      size: 'md' as const,
    })),
    { id: 'slower', text: '← slower', tone: 'mute', side: 'right', size: 'sm' },
    { id: 'faster', text: 'faster →', tone: 'mute', side: 'left', size: 'sm' },
    { id: 'yTitle', text: 'height at San Francisco', tone: 'mute', side: 'right', size: 'sm' },
  ];
  const labels = new LabelSet(labelSpecs);
  const LB = Object.fromEntries(labelSpecs.map((s, i) => [s.id, i])) as Record<string, number>;

  let n = 0;
  const L = {
    bars: LINES.map(() => n++),
    axis: n++,
    grid: params.grid.map(() => n++),
  };

  const self: BlockScene = {
    id: 'rhythms',
    status: 'established',
    statusNote: rhythms.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const specs: LineSpec[] = [];
      LINES.forEach(
        (l, i) =>
          (specs[L.bars[i]!] = {
            points: new Float32Array([0, 0, 0, l.H]),
            colour: FAMILY[l.family],
            width: 2.6,
            intensity: 1.0,
          }),
      );
      specs[L.axis] = { points: new Float32Array([0, 0, 1, 0]), colour: C.grid, width: 1.2, intensity: 0.6 };
      params.grid.forEach(
        (_, i) =>
          (specs[L.grid[i]!] = {
            points: new Float32Array([0, 0, 1, 0]),
            colour: C.faint,
            width: 1,
            intensity: 0.5,
            dash: 0.02,
          }),
      );
      lines = createLines(specs, { resolution: ctx.globals.uResolution });
      scene.add(lines.mesh);
      disposers.push(lines.dispose);
      dots = createEvents(
        kit,
        LINES.map((l) => ({ p: [0, 0, 0] as const, colour: FAMILY[l.family], size: 0.026, intensity: 1.4 })),
        ctx.globals.uElapsed,
        { pulse: 0.04 },
      );
      scene.add(dots.object);
      disposers.push(dots.dispose);
      self.update(0, 0, 0);
      await renderer.compileAsync(scene, camera);
    },

    update(local, _dt, elapsed) {
      state = rhythmsState(local);
      const s = state;
      const S = lines.state;
      camera.position.set(Math.sin(elapsed * 0.05) * 0.03, Math.sin(elapsed * 0.037 + 1) * 0.02, D);
      camera.lookAt(0, 0, 0);

      const t = s.table;
      const x0 = lay.x0 + (lay.tx0 - lay.x0) * t;
      const x1 = lay.x1 + (lay.tx1 - lay.x1) * t;
      const mid = (x0 + x1) / 2;
      const per = (x1 - x0) / (2 * s.half);
      const xOf = (a: number) => mid + (a - s.centre) * per;
      // Portrait: the table card sits at the top of a phone, so the spectrum steps down when it appears.
      const base = lay.base - (lay.portrait ? 0.08 * s.table : 0);
      const k = lay.k;
      const focus = BEATS[s.beat]!.focus;
      const focusing = focus.length > 0 ? s.settled : 0;
      const zoomed = s.half < VIEWS.all.half * 0.5 ? 1 : 0;

      LINES.forEach((l, i) => {
        const x = xOf(axisOf(l.speed));
        const out = Math.max(0, x0 - 0.04 - x, x - x1 - 0.04);
        const inView = Math.max(0, 1 - out / 0.08);
        const isFocus = focus.includes(l.name);
        const dim = isFocus ? 1 : 1 - 0.65 * focusing;
        const grow = s.grow * s.yScale;
        Object.assign(S[L.bars[i]!]!, {
          x,
          y: base,
          sx: 1,
          sy: k * grow,
          intensity: inView * dim * 0.85,
          highlight: isFocus ? 0.4 * focusing : 0,
          width: 1,
        });
        dots.setPos(i, x, base + k * l.H * grow, 0);
        dots.setIntensity(i, 1.4 * inView * dim * Math.min(1, grow * 3));
        dots.setSize(i, 0.022 * (1 + (isFocus ? 0.6 * focusing : 0)));
        // Names: big ones in the overview, all of a family once its zoom has landed; focus lines get their cause.
        const named = zoomed
          ? s.settled
          : params.overviewNames.includes(l.name)
            ? Math.max(s.settled, 0) * grow
            : 0;
        const showName = named * inView * (isFocus ? 1 - focusing : 1);
        labels.place(LB[`n${l.name}`]!, x, base + k * l.H * grow + 0.012, 0, camera, showName);
        if (focusAll.has(l.name)) {
          // Portrait is too narrow for side-by-side causes: stagger them down the screen and keep them inside it.
          const fi = focus.indexOf(l.name);
          const P = lay.portrait;
          const fx = P ? Math.max(lay.x0 + 0.2, Math.min(lay.x1 - 0.2, x)) : x;
          const fy = P
            ? Math.max(base + k * l.H * grow + 0.012, base + k * 0.86 - fi * 0.22)
            : base + k * l.H * grow + 0.012;
          labels.place(LB[`f${l.name}`]!, fx, fy, 0, camera, isFocus ? focusing * inView : 0);
        }
      });

      Object.assign(S[L.axis]!, {
        x: x0 - 0.04,
        y: base,
        sx: x1 - x0 + 0.08,
        sy: 1,
        intensity: 0.4 + 0.6 * s.grow,
      });
      // Grid: 10 cm steps at the overview's scale, finer steps (labelled in cm) when a small family is magnified.
      const ys = s.yScale;
      const step = ys < 1.5 ? 0.1 : ys < 3 ? 0.05 : ys < 7 ? 0.02 : ys < 12 ? 0.01 : 0.005;
      params.grid.forEach((_, i) => {
        const m = step * (i + 1);
        const y = base + k * ys * m;
        const on = y < base + k * 0.7 ? s.grow : 0;
        Object.assign(S[L.grid[i]!]!, { x: x0 - 0.04, y, sx: x1 - x0 + 0.08, sy: 1, intensity: on * 0.8 });
        labels.setText(
          LB[`g${params.grid[i]}`]!,
          step >= 0.1 ? `${m.toFixed(1)} m` : `${Math.round(m * 1000) / 10} cm`,
        );
        labels.place(
          LB[`g${params.grid[i]}`]!,
          x0 - 0.05,
          y,
          0,
          camera,
          on * (i % 2 === 0 || !lay.portrait ? 0.8 : 0),
        );
      });
      labels.place(LB.yTitle!, x0 - 0.04, base + k * 0.68, 0, camera, s.grow * 0.8 * (1 - focusing));
      families.forEach((f) => {
        const x = xOf(axisOf(f.at));
        const inView = x > x0 - 0.1 && x < x1 + 0.1 ? 1 : 0;
        labels.place(LB[f.id]!, x, base - 0.03, 0, camera, Math.min(1, s.families) * inView * s.grow);
      });
      labels.place(LB.slower!, x0 - 0.04, base - 0.12, 0, camera, s.grow * 0.7);
      labels.place(LB.faster!, x1 + 0.04, base - 0.12, 0, camera, s.grow * 0.7);
      lines.commit();
      dots.commit();
    },

    render(target: RenderTarget) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },

    resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      lay = layout(camera.aspect);
      for (const name of focusAll) labels.setText(LB[`f${name}`]!, focusText(name, lay.portrait));
      for (const f of families) labels.setText(LB[f.id]!, lay.portrait ? f.short : f.text);
    },

    dispose() {
      for (const d of disposers) d();
    },
  };
  return self;
}

/** World units: y ∈ [−1, 1], x ∈ [−aspect, aspect] at z = 0. The spectrum stands above the caption corner. */
function layout(aspect: number): Layout {
  const hw = aspect;
  if (aspect >= 1)
    return {
      x0: -hw + 0.42,
      x1: hw - 0.22,
      tx0: -hw + 0.42,
      tx1: 0.6,
      base: -0.06,
      k: 1.12,
      portrait: false,
    };
  return {
    x0: -hw + 0.16,
    x1: hw - 0.06,
    tx0: -hw + 0.16,
    tx1: hw - 0.06,
    base: -0.33,
    k: 0.9,
    portrait: true,
  };
}
