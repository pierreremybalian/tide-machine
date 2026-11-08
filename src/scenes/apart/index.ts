// Stage 7 · Taking the tide apart — harmonic analysis of a real year (HANDOFF §7, §9 "phasor clock").
// The 2025 record at San Francisco is drawn as one glowing trace, zooms to December, then unweaves: each fitted rhythm
// peels off into its own row with a dial whose arm length is its height and whose angle is its timing. A polar plot
// sets our fit beside NOAA's published constants. The rows add back up to the record; what is left is weather.

import { PerspectiveCamera, Scene, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createKit } from '../../shared/gfx/kit.ts';
import { createEvents, type Events } from '../../shared/gfx/events.ts';
import { LabelSet, type LabelSpec, type Tone } from '../../shared/gfx/labels.ts';
import { PAL, type RGB } from '../../shared/gfx/palette.ts';
import { circlePoints, createLines, type LineSpec, type Lines } from './lines.ts';
import {
  apart,
  apartState,
  FIT,
  FIT_Z0,
  fitOf,
  RECORD,
  recordDate,
  ROWS,
  SURGE,
  WINDOW,
  type ApartState,
} from '../../script/apart.ts';
import { lineByName, prettyName, sfConstant } from '../../script/rhythms.ts';
import { astro, D2R, type Astro } from '../../tides/astro.ts';
import { BY_NAME, V } from '../../tides/constituents.ts';
import { prepare, predict, termHeight, type Term } from '../../tides/predict.ts';
import { smooth } from '../../time/tracks.ts';

const FAMILY: Record<string, RGB> = {
  semidiurnal: [0.5, 0.82, 1.0],
  diurnal: PAL.a,
  long: PAL.light,
  shallow: PAL.green,
  terdiurnal: PAL.green,
};
const TONE: Record<string, Tone> = {
  semidiurnal: 'b',
  diurnal: 'a',
  long: 'light',
  shallow: 'plain',
  terdiurnal: 'plain',
};
const C = {
  record: [0.92, 0.95, 1.0] as RGB,
  sum: PAL.sun,
  residual: [1.0, 0.55, 0.38] as RGB,
  grid: [0.36, 0.42, 0.62] as RGB,
  faint: [0.24, 0.28, 0.42] as RGB,
};

const params = {
  fov: 30,
  /** Row curves sampled every half hour. */
  step: 0.5,
};

interface Layout {
  /** Year view: x range, centre line, metres → world. */
  ya: { x0: number; x1: number; y: number; k: number };
  /** Column view (December): record line and rows. */
  col: { x0: number; x1: number; y: number; k: number };
  rowY: number[];
  rowK: number;
  dialX: number;
  /** Where the residual settles. */
  resY: number;
  resK: number;
  polar: { x: number; y: number; k: number; on: number };
  portrait: boolean;
}

export default function apartScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const camera = new PerspectiveCamera(params.fov, 16 / 9, 0.1, 50);
  const kit = createKit();
  const disposers: (() => void)[] = [];
  let lines: Lines;
  let dots: Events;
  const st: ApartState = apartState(0);
  let lay = layout(16 / 9);
  const D = 1 / Math.tan((params.fov / 2) * (Math.PI / 180));
  const a = {} as Astro;

  const terms: Term[] = ROWS.map((n) => ({ c: BY_NAME.get(n)!, H: fitOf(n).H, kappa: fitOf(n).kappa }));
  const winN = Math.round((WINDOW.to - WINDOW.from) / params.step) + 1;
  const monthStarts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const decTicks = [1, 8, 15, 22, 29];

  const labelSpecs: LabelSpec[] = [
    {
      id: 'title',
      text: 'San Francisco · hourly water level, 2025',
      tone: 'mute',
      side: 'right',
      size: 'sm',
    },
    { id: 'sumL', text: 'sum of the 31 fitted rhythms', tone: 'warm', side: 'right', size: 'sm' },
    { id: 'resL', text: 'left over: weather', tone: 'warm', side: 'right', size: 'sm' },
    {
      id: 'surge',
      text: `${recordDate(SURGE.hours)} · +${SURGE.metres.toFixed(2)} m`,
      tone: 'warm',
      side: 'above',
      size: 'sm',
    },
    { id: 'cursor', text: '', tone: 'mute', side: 'below', size: 'sm' },
    { id: 'polarT', text: 'Height and timing · ● ours ○ NOAA', tone: 'mute', side: 'center', size: 'sm' },
    { id: 'p0', text: '0°', tone: 'mute', side: 'above', size: 'sm' },
    { id: 'p90', text: '90°', tone: 'mute', side: 'right', size: 'sm' },
    { id: 'p180', text: '180°', tone: 'mute', side: 'below', size: 'sm' },
    { id: 'p270', text: '270°', tone: 'mute', side: 'left', size: 'sm' },
    { id: 'pr', text: '0.6 m', tone: 'mute', side: 'right', size: 'sm' },
    ...ROWS.map((n) => ({
      id: `row${n}`,
      text: prettyName(n),
      tone: TONE[lineByName(n).family]!,
      side: 'right' as const,
      size: 'md' as const,
    })),
    ...ROWS.map((n) => ({
      id: `rowL${n}`,
      text: prettyName(n),
      tone: TONE[lineByName(n).family]!,
      side: 'left' as const,
      size: 'md' as const,
    })),
    ...ROWS.map((n) => ({
      id: `pt${n}`,
      text: prettyName(n),
      tone: TONE[lineByName(n).family]!,
      side: (n === 'S2' ? 'left' : 'right') as LabelSpec['side'],
      size: 'sm' as const,
    })),
    ...monthStarts.map((d, i) => ({
      id: `m${i}`,
      text: recordDate(d * 24).split(' ')[0]!,
      tone: 'mute' as const,
      side: 'below' as const,
      size: 'sm' as const,
    })),
    ...decTicks.map((d) => ({
      id: `dec${d}`,
      text: `Dec ${d}`,
      tone: 'mute' as const,
      side: 'below' as const,
      size: 'sm' as const,
    })),
  ];
  const labels = new LabelSet(labelSpecs);
  const LB = Object.fromEntries(labelSpecs.map((s, i) => [s.id, i])) as Record<string, number>;

  // Line indices.
  let n = 0;
  const L = {
    year: n++,
    sum: n++,
    residual: n++,
    base: n++,
    resBase: n++,
    cursor: n++,
    polarRing0: n++,
    polarRing1: n++,
    polarRing2: n++,
    polarAxisH: n++,
    polarAxisV: n++,
    rows: ROWS.map(() => n++),
    rowBase: ROWS.map(() => n++),
    rings: ROWS.map(() => n++),
    arms: ROWS.map(() => n++),
    proj: ROWS.map(() => n++),
    noaa: ROWS.map(() => n++),
    ticks: monthStarts.map(() => n++),
    decTicks: decTicks.map(() => n++),
  };

  const self: BlockScene = {
    id: 'apart',
    status: 'measured',
    statusNote: apart.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const rec = await ctx.assets.json<{ values: (number | null)[] }>(RECORD.url);
      // Record relative to the fitted mean level (missing hours repeat the previous reading).
      const year = new Float32Array(RECORD.hours * 2);
      let last = FIT_Z0;
      for (let i = 0; i < RECORD.hours; i++) {
        const v = rec.values[i];
        if (v !== null && v !== undefined) last = v / 1000;
        year[i * 2] = i;
        year[i * 2 + 1] = last - FIT_Z0;
      }
      // Our fit (all 31 rhythms) for December, the rows, and the residual.
      const fit = prepare({
        id: 'fit',
        z0: 0,
        constituents: FIT.map(([name, H, kappa]) => ({ name, amplitude: H, phase: kappa, speed: 0 })),
      });
      const sum = new Float32Array(winN * 2);
      const rows = ROWS.map(() => new Float32Array(winN * 2));
      for (let i = 0; i < winN; i++) {
        const h = WINDOW.from + i * params.step;
        const ms = RECORD.start + h * 3600e3;
        sum[i * 2] = h;
        sum[i * 2 + 1] = predict(fit, ms);
        astro(ms, a);
        terms.forEach((t, r) => {
          rows[r]![i * 2] = h;
          rows[r]![i * 2 + 1] = termHeight(t, a);
        });
      }
      const resN = WINDOW.to - WINDOW.from;
      const residual = new Float32Array(resN * 2);
      for (let i = 0; i < resN; i++) {
        const h = WINDOW.from + i;
        residual[i * 2] = h;
        residual[i * 2 + 1] = year[h * 2 + 1]! - predict(fit, RECORD.start + h * 3600e3);
      }

      const circle = circlePoints(128);
      const unit = new Float32Array([0, 0, 1, 0]);
      const vert = new Float32Array([0, 0, 0, 1]);
      const span = new Float32Array([0, 0, RECORD.hours, 0]);
      const specs: LineSpec[] = [];
      specs[L.year] = { points: year, colour: C.record, width: 1.5, intensity: 0.75 };
      specs[L.sum] = { points: sum, colour: C.sum, width: 1.6, intensity: 0.9 };
      specs[L.residual] = { points: residual, colour: C.residual, width: 1.8, intensity: 1.1 };
      specs[L.base] = { points: span, colour: C.grid, width: 1, intensity: 0.3 };
      specs[L.resBase] = { points: span, colour: C.residual, width: 1, intensity: 0.3, dash: 0.02 };
      specs[L.cursor] = { points: vert, colour: C.grid, width: 1, intensity: 0.6, dash: 0.02 };
      specs[L.polarRing0] = {
        points: circle,
        colour: C.faint,
        width: 1,
        intensity: 0.6,
        closed: true,
        dash: 0.018,
      };
      specs[L.polarRing1] = {
        points: circle,
        colour: C.faint,
        width: 1,
        intensity: 0.6,
        closed: true,
        dash: 0.018,
      };
      specs[L.polarRing2] = { points: circle, colour: C.faint, width: 1, intensity: 0.7, closed: true };
      specs[L.polarAxisH] = {
        points: new Float32Array([-1, 0, 1, 0]),
        colour: C.faint,
        width: 1,
        intensity: 0.6,
      };
      specs[L.polarAxisV] = {
        points: new Float32Array([0, -1, 0, 1]),
        colour: C.faint,
        width: 1,
        intensity: 0.6,
      };
      ROWS.forEach((name, i) => {
        const col = FAMILY[lineByName(name).family]!;
        specs[L.rows[i]!] = { points: rows[i]!, colour: col, width: 1.3, intensity: 0.5 };
        specs[L.rowBase[i]!] = { points: span, colour: C.grid, width: 1, intensity: 0.22 };
        specs[L.rings[i]!] = { points: circle, colour: col, width: 1, intensity: 0.3, closed: true };
        specs[L.arms[i]!] = { points: unit, colour: col, width: 2.4, intensity: 1.0 };
        specs[L.proj[i]!] = { points: unit, colour: col, width: 1, intensity: 0.35, dash: 0.018 };
        specs[L.noaa[i]!] = {
          points: circlePoints(40),
          colour: [0.95, 0.96, 1.0],
          width: 1.2,
          intensity: 0.9,
          closed: true,
        };
      });
      monthStarts.forEach(
        (d, i) =>
          (specs[L.ticks[i]!] = {
            points: new Float32Array([d * 24, 0, d * 24, -1]),
            colour: C.grid,
            width: 1,
            intensity: 0.5,
          }),
      );
      decTicks.forEach((d, i) => {
        const h = WINDOW.from + (d - 1) * 24;
        specs[L.decTicks[i]!] = {
          points: new Float32Array([h, 0, h, -1]),
          colour: C.grid,
          width: 1,
          intensity: 0.5,
        };
      });
      lines = createLines(specs, { resolution: ctx.globals.uResolution });
      scene.add(lines.mesh);
      disposers.push(lines.dispose);

      dots = createEvents(
        kit,
        [
          ...ROWS.map((name) => ({
            p: [0, 0, 0] as const,
            colour: FAMILY[lineByName(name).family]!,
            size: 0.03,
            intensity: 1.4,
          })), // cursor dots
          ...ROWS.map((name) => ({
            p: [0, 0, 0] as const,
            colour: FAMILY[lineByName(name).family]!,
            size: 0.03,
            intensity: 1.4,
          })), // arm tips
          ...ROWS.map((name) => ({
            p: [0, 0, 0] as const,
            colour: FAMILY[lineByName(name).family]!,
            size: 0.034,
            intensity: 1.6,
          })), // polar: ours
          { p: [0, 0, 0], colour: C.residual, size: 0.05, intensity: 1.8 }, // surge
        ],
        ctx.globals.uElapsed,
        { pulse: 0.03 },
      );
      scene.add(dots.object);
      disposers.push(dots.dispose);
      self.update(0, 0, 0);
      await renderer.compileAsync(scene, camera);
    },

    update(local, _dt, elapsed) {
      apartState(local, st);
      const s = st;
      const S = lines.state;
      camera.position.set(Math.sin(elapsed * 0.05) * 0.03, Math.sin(elapsed * 0.037 + 1) * 0.02, D);
      camera.lookAt(0, 0, 0);

      // The record: the year, then December; then it moves into the column above the rows.
      const zoom = smooth(s.zoom);
      const span = Math.exp(
        Math.log(RECORD.hours) + (Math.log(WINDOW.to - WINDOW.from) - Math.log(RECORD.hours)) * zoom,
      );
      const w1 = RECORD.hours;
      const w0 = w1 - span;
      const c = smooth(s.column);
      const ya = lay.ya;
      const cl = lay.col;
      const X0 = ya.x0 + (cl.x0 - ya.x0) * c;
      const X1 = ya.x1 + (cl.x1 - ya.x1) * c;
      const Y = ya.y + (cl.y - ya.y) * c;
      const K = ya.k + (cl.k - ya.k) * c;
      const xs = (X1 - X0) / span;
      const ox = X0 - w0 * xs;
      const toX = (h: number) => ox + h * xs;
      const fromF = w0 / (RECORD.hours - 1);
      const drawn = s.draw;
      // Dense traces add up under additive blending: dim the record with the hours packed into each world unit.
      const density = Math.min(1, Math.pow(xs / 0.0039, 0.7));
      const recOn = Math.min(1, 0.25 + drawn) * (1 - 0.35 * s.sum) * density;
      Object.assign(S[L.year]!, {
        x: ox,
        y: Y,
        sx: xs,
        sy: K,
        from: Math.min(fromF, drawn),
        to: drawn,
        intensity: recOn,
        head: 0.6,
      });
      Object.assign(S[L.base]!, {
        x: ox,
        y: Y,
        sx: xs,
        sy: 1,
        from: fromF,
        to: 1,
        intensity: 0.5 + 0.5 * drawn,
      });
      // Decimal hour → index fraction for December series (0.5 h step) and the hourly residual.
      Object.assign(S[L.sum]!, {
        x: ox,
        y: Y,
        sx: xs,
        sy: K,
        from: 0,
        to: s.sum,
        intensity: s.sum,
        head: 0.6,
      });

      // Time ticks under the record.
      const tickY = Y - K * 1.25;
      monthStarts.forEach((d, i) => {
        const on = (1 - zoom) * (1 - c) * Math.min(1, drawn * 1.5);
        Object.assign(S[L.ticks[i]!]!, { x: ox, y: tickY, sx: xs, sy: 0.025, intensity: on });
        labels.place(LB[`m${i}`]!, toX(d * 24 + 15 * 24), tickY - 0.005, 0, camera, on * 0.85);
      });
      decTicks.forEach((d, i) => {
        const h = WINDOW.from + (d - 1) * 24;
        const on = zoom * (1 - s.residual * 0) * (h >= w0 ? 1 : 0);
        Object.assign(S[L.decTicks[i]!]!, {
          x: ox,
          y: tickY,
          sx: xs,
          sy: 0.025,
          intensity: on * (1 - c * 0.3),
        });
        labels.place(LB[`dec${d}`]!, toX(h), tickY - 0.03, 0, camera, on * (1 - c) * 0.85);
      });
      labels.place(LB.title!, X0, Y + K * 1.45, 0, camera, 0.9 * Math.min(1, drawn * 2));

      // Rows: each fitted rhythm peels off the record into its own line, with a dial at the right.
      const cx = toX(s.cursor);
      for (let i = 0; i < ROWS.length; i++) {
        const p = smooth(s.peel[i]!);
        const yRow = Y + (lay.rowY[i]! - Y) * p;
        const kRow = K + (lay.rowK - K) * p;
        const on = Math.min(1, s.peel[i]! * 4);
        Object.assign(S[L.rows[i]!]!, {
          x: ox,
          y: yRow,
          sx: xs,
          sy: kRow,
          intensity: on,
          highlight: i === 0 ? s.m2 : 0,
        });
        Object.assign(S[L.rowBase[i]!]!, {
          x: ox,
          y: yRow,
          sx: xs,
          sy: 1,
          from: (WINDOW.from / RECORD.hours) * 0.999,
          to: 1,
          intensity: on * p,
        });
        // Dial: arm angle V + u − κ at the cursor (+90° so its height is the row's value).
        const t = terms[i]!;
        astro(RECORD.start + s.cursor * 3600e3, a);
        const f = t.c.f(a);
        const th = (V(t.c, a) + t.c.u(a) - t.kappa) * D2R + Math.PI / 2;
        const rr = lay.rowK * f * t.H;
        const dx = lay.dialX;
        const dy = lay.rowY[i]!;
        const tipX = dx + rr * Math.cos(th);
        const tipY = dy + rr * Math.sin(th);
        const dOn = p * p;
        Object.assign(S[L.rings[i]!]!, { x: dx, y: dy, sx: rr, sy: rr, intensity: dOn });
        Object.assign(S[L.arms[i]!]!, {
          x: dx,
          y: dy,
          sx: rr,
          sy: rr,
          rot: th,
          intensity: dOn,
          highlight: i === 0 ? s.m2 : 0,
        });
        const vy = yRow + kRow * termHeight(t, a);
        Object.assign(S[L.proj[i]!]!, { x: cx, y: vy, sx: tipX - cx, sy: 1, intensity: dOn * 0.8 });
        dots.setPos(i, cx, vy, 0);
        dots.setIntensity(i, 1.3 * dOn);
        dots.setPos(ROWS.length + i, tipX, tipY, 0);
        dots.setIntensity(ROWS.length + i, 1.3 * dOn);
        const name = ROWS[i]!;
        labels.place(LB[`row${name}`]!, dx + lay.rowK * 0.62, dy, 0, camera, lay.portrait ? 0 : dOn);
        labels.place(LB[`rowL${name}`]!, X0 - 0.02, dy, 0, camera, lay.portrait ? dOn : 0);

        // Polar plot: our (H, κ) as a dot, NOAA's as a ring; κ clockwise from the top.
        const pl = lay.polar;
        const pOn = s.polar * pl.on * Math.min(1, s.seen[i]! * 4);
        const ours = fitOf(name);
        const noaa = sfConstant(name);
        const ang = (k: number) => (90 - k) * D2R;
        dots.setPos(
          2 * ROWS.length + i,
          pl.x + pl.k * ours.H * Math.cos(ang(ours.kappa)),
          pl.y + pl.k * ours.H * Math.sin(ang(ours.kappa)),
          0,
        );
        dots.setIntensity(2 * ROWS.length + i, 1.5 * pOn * (1 + (i === 0 ? s.m2 : 0)));
        dots.setSize(2 * ROWS.length + i, 0.03 * (1 + (i === 0 ? 0.5 * s.m2 : 0)));
        const nr = 0.022 * (1 + (i === 0 ? 0.6 * s.m2 : 0));
        Object.assign(S[L.noaa[i]!]!, {
          x: pl.x + pl.k * noaa.H * Math.cos(ang(noaa.kappa)),
          y: pl.y + pl.k * noaa.H * Math.sin(ang(noaa.kappa)),
          sx: nr,
          sy: nr,
          intensity: pOn,
        });
        const lx = pl.x + pl.k * ours.H * Math.cos(ang(ours.kappa));
        const ly = pl.y + pl.k * ours.H * Math.sin(ang(ours.kappa));
        labels.place(
          LB[`pt${name}`]!,
          lx + (name === 'S2' ? -0.02 : 0.02),
          ly,
          0,
          camera,
          pOn * (i < 4 ? 1 : 0),
        );
      }
      const anyRow = Math.min(1, s.peel[0]! * 4);
      const top = Y + K * 0.9;
      const bottom = lay.rowY[ROWS.length - 1]! - lay.rowK * 0.6;
      Object.assign(S[L.cursor]!, { x: cx, y: bottom, sx: 1, sy: top - bottom, intensity: anyRow });
      labels.setText(LB.cursor!, recordDate(s.cursor, true));
      labels.place(LB.cursor!, cx, bottom - 0.01, 0, camera, anyRow * 0.9);

      // Polar frame.
      const pl = lay.polar;
      const pOn = s.polar * pl.on;
      [0.2, 0.4, 0.6].forEach((m, i) =>
        Object.assign(S[[L.polarRing0, L.polarRing1, L.polarRing2][i]!]!, {
          x: pl.x,
          y: pl.y,
          sx: pl.k * m,
          sy: pl.k * m,
          intensity: pOn,
        }),
      );
      const R = pl.k * 0.66;
      Object.assign(S[L.polarAxisH]!, { x: pl.x, y: pl.y, sx: R, sy: 1, intensity: pOn });
      Object.assign(S[L.polarAxisV]!, { x: pl.x, y: pl.y, sx: 1, sy: R, intensity: pOn });
      labels.place(LB.polarT!, pl.x, pl.y + R + 0.1, 0, camera, pOn);
      labels.place(LB.p0!, pl.x, pl.y + R, 0, camera, pOn * 0.8);
      labels.place(LB.p90!, pl.x + R, pl.y, 0, camera, pOn * 0.8);
      labels.place(LB.p180!, pl.x, pl.y - R, 0, camera, pOn * 0.8);
      labels.place(LB.p270!, pl.x - R, pl.y, 0, camera, pOn * 0.8);
      labels.place(LB.pr!, pl.x + pl.k * 0.6 * 0.71, pl.y - pl.k * 0.6 * 0.71, 0, camera, pOn * 0.6);

      // Sum and residual: the residual drops out of the record into the space the rows leave.
      const rz = smooth(s.residual);
      const yRes = Y + (lay.resY - Y) * rz;
      const kRes = K + (lay.resK - K) * rz;
      Object.assign(S[L.residual]!, { x: ox, y: yRes, sx: xs, sy: kRes, from: 0, to: 1, intensity: rz });
      Object.assign(S[L.resBase]!, {
        x: ox,
        y: yRes,
        sx: xs,
        sy: 1,
        from: WINDOW.from / RECORD.hours,
        to: 1,
        intensity: rz,
      });
      labels.place(LB.sumL!, X1 + 0.02, Y + K * 0.9, 0, camera, s.sum * (1 - rz) * (lay.portrait ? 0 : 1));
      labels.place(LB.resL!, X0, yRes + lay.resK * 0.62, 0, camera, rz);
      const sx = toX(SURGE.hours);
      const sy = yRes + kRes * SURGE.metres;
      dots.setPos(3 * ROWS.length, sx, sy, 0);
      dots.setIntensity(3 * ROWS.length, 1.8 * rz);
      labels.place(LB.surge!, sx, sy + 0.02, 0, camera, rz);
      dots.commit();
      lines.commit();
    },

    render(target: RenderTarget) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },

    resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      lay = layout(camera.aspect);
    },

    dispose() {
      for (const d of disposers) d();
    },
  };
  return self;
}

/** World units: the view spans y ∈ [−1, 1] and x ∈ [−aspect, aspect] at z = 0. Captions sit bottom-left, the dual
 * clock top-right, so the rows stack in the right-hand column and the polar plot takes the upper left. */
function layout(aspect: number): Layout {
  const hw = aspect;
  if (aspect >= 1) {
    const rowY = ROWS.map((_, i) => 0.2 - i * 0.132);
    return {
      ya: { x0: -hw + 0.24, x1: hw - 0.14, y: 0.12, k: 0.24 },
      col: { x0: 0.06, x1: hw - 0.5, y: 0.47, k: 0.13 },
      rowY,
      rowK: 0.13,
      dialX: hw - 0.33,
      resY: -0.1,
      resK: 0.36,
      polar: { x: -hw + 0.72, y: 0.3, k: 0.62, on: 1 },
      portrait: false,
    };
  }
  const rowY = ROWS.map((_, i) => 0.34 - i * 0.085);
  return {
    ya: { x0: -hw + 0.05, x1: hw - 0.05, y: 0.3, k: 0.13 },
    col: { x0: -hw + 0.12, x1: hw - 0.16, y: 0.5, k: 0.08 },
    rowY,
    rowK: 0.08,
    dialX: hw - 0.08,
    resY: 0.18,
    resK: 0.24,
    polar: { x: 0, y: -0.2, k: 0.3, on: 0 },
    portrait: true,
  };
}
