// Stage 5 · The Sun joins in — M2 and S2 as arms on a dial (HANDOFF §7, §9 "phasor clock", "range breathing").
// The Moon's arm (M2) turns once every 12 h 25 min; the Sun's (S2) hangs on its end and turns once every 12 h. The tip's
// height is the tide, written on a chart beside the dial. S2 gains on M2 and laps it every 14.77 days: riding along
// with M2, the sum's length breathes between spring and neap, in step with the Moon's phases (sketch, bottom right).

import { PerspectiveCamera, Scene, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createKit } from '../../shared/gfx/kit.ts';
import { createEvents, type Events } from '../../shared/gfx/events.ts';
import { LabelSet, type LabelSpec } from '../../shared/gfx/labels.ts';
import { PAL, type RGB } from '../../shared/gfx/palette.ts';
import { circlePoints, createLines, type LineSpec, type Lines } from './lines.ts';
import {
  arms,
  dateLabel,
  FIRST_WINDOW_H,
  S2_JOIN_H,
  skyEvents,
  SPAN_H,
  sun,
  sunCurves,
  sunState,
  type Arms,
  type SunState,
} from '../../script/sun.ts';
import { MOON_BULGE_M, SUN_BULGE_M } from '../../tides/equilibrium.ts';
import { smooth } from '../../time/tracks.ts';

const C = {
  m2: [0.5, 0.82, 1.0] as RGB,
  s2: PAL.sun,
  sum: [1.0, 0.96, 0.9] as RGB,
  grid: [0.36, 0.42, 0.62] as RGB,
  faint: [0.24, 0.28, 0.42] as RGB,
  moon: PAL.moon,
  earth: PAL.earth,
};

const params = {
  fov: 30,
  /** Curve sampling (hours). */
  step: 0.25,
  /** Inset bulges: drawn height per metre of equilibrium bulge, in Earth radii (schematic). */
  insetBulge: 1.6,
  insetEarth: 0.36,
};

interface Layout {
  /** Dial centre and metres → world. */
  cx: number;
  cy: number;
  k: number;
  /** Chart x range (world). */
  x0: number;
  x1: number;
  /** Inset centre and orbit radius. */
  ix: number;
  iy: number;
  is: number;
  portrait: boolean;
}

export default function sunScene(): BlockScene {
  let renderer: WebGPURenderer;
  const scene = new Scene();
  const camera = new PerspectiveCamera(params.fov, 16 / 9, 0.1, 50);
  const kit = createKit();
  const disposers: (() => void)[] = [];
  let lines: Lines;
  let dots: Events;
  let state: SunState = sunState(0);
  const r = {} as Arms;
  let lay: Layout = layout(16 / 9);
  const D = 1 / Math.tan((params.fov / 2) * (Math.PI / 180));

  const ev = skyEvents();
  const springs = ev.filter((e) => e.kind === 'spring' || e.kind === 'neap');
  const phases = ev.filter(
    (e) => e.kind === 'new' || e.kind === 'first' || e.kind === 'full' || e.kind === 'last',
  );
  const PHASE_TEXT = {
    new: 'new moon',
    first: 'first quarter',
    full: 'full moon',
    last: 'last quarter',
  } as const;
  const PHASE_SHORT = { new: 'new', first: '1st qtr', full: 'full', last: '3rd qtr' } as const;
  const days = Array.from({ length: 31 }, (_, d) => d);

  const labelSpecs: LabelSpec[] = [
    { id: 'm2', text: 'M2 · Moon', tone: 'b', side: 'center', size: 'sm' },
    { id: 's2', text: 'S2 · Sun', tone: 'warm', side: 'center', size: 'sm' },
    { id: 'sum', text: 'M2 + S2', tone: 'both', side: 'center', size: 'sm' },
    { id: 'chart', text: 'San Francisco, M2 + S2', tone: 'mute', side: 'right', size: 'sm' },
    { id: 'sunL', text: 'Sun', tone: 'warm', side: 'below', size: 'sm' },
    { id: 'moonL', text: 'Moon', tone: 'plain', side: 'right', size: 'sm' },
    ...springs.map((e, i) => ({
      id: `sn${i}`,
      text: e.kind,
      tone: (e.kind === 'spring' ? 'both' : 'mute') as LabelSpec['tone'],
      side: 'above' as const,
      size: 'sm' as const,
    })),
    ...phases.map((e, i) => ({
      id: `ph${i}`,
      text: PHASE_TEXT[e.kind as keyof typeof PHASE_TEXT],
      tone: 'light' as const,
      side: 'below' as const,
      size: 'sm' as const,
    })),
    ...days.map((d) => ({
      id: `d${d}`,
      text: dateLabel(d * 24, false),
      tone: 'mute' as const,
      side: 'below' as const,
      size: 'sm' as const,
    })),
  ];
  const labels = new LabelSet(labelSpecs);
  const LB = Object.fromEntries(labelSpecs.map((s, i) => [s.id, i])) as Record<string, number>;

  // Line indices.
  const L = {
    ringSpring: 0,
    ringNeap: 1,
    ringM2: 2,
    axisH: 3,
    axisV: 4,
    armM2: 5,
    armS2: 6,
    armSum: 7,
    proj: 8,
    base: 9,
    curveM2: 10,
    ghostM2: 11,
    curveBoth: 12,
    envUp: 13,
    envDn: 14,
    sumRing: 15,
    timeAxis: 16,
    orbit: 17,
    sunAxis: 18,
    bulgeM: 19,
    bulgeS: 20,
    earth: 21,
    dayTick0: 22,
  };
  const phaseTick0 = L.dayTick0 + days.length;

  const self: BlockScene = {
    id: 'sun',
    status: 'measured',
    statusNote: sun.note,
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const curves = sunCurves(params.step);
      const flat = (ys: Float32Array, sign = 1) => {
        const out = new Float32Array(ys.length * 2);
        for (let i = 0; i < ys.length; i++) {
          out[i * 2] = curves.t[i]!;
          out[i * 2 + 1] = ys[i]! * sign;
        }
        return out;
      };
      const unit = new Float32Array([0, 0, 1, 0]);
      const circle = circlePoints(160);
      const specs: LineSpec[] = [];
      specs[L.ringSpring] = {
        points: circle,
        colour: C.faint,
        width: 1.1,
        intensity: 0.5,
        closed: true,
        dash: 0.02,
      };
      specs[L.ringNeap] = {
        points: circle,
        colour: C.faint,
        width: 1.1,
        intensity: 0.5,
        closed: true,
        dash: 0.02,
      };
      specs[L.ringM2] = { points: circle, colour: C.m2, width: 1.2, intensity: 0.22, closed: true };
      specs[L.axisH] = { points: new Float32Array([-1, 0, 1, 0]), colour: C.grid, width: 1, intensity: 0.35 };
      specs[L.axisV] = { points: new Float32Array([0, -1, 0, 1]), colour: C.grid, width: 1, intensity: 0.35 };
      specs[L.armM2] = { points: unit, colour: C.m2, width: 2.8, intensity: 0.85 };
      specs[L.armS2] = { points: unit, colour: C.s2, width: 2.8, intensity: 1.0 };
      specs[L.armSum] = { points: unit, colour: C.sum, width: 1.4, intensity: 0.7 };
      specs[L.proj] = { points: unit, colour: C.sum, width: 1, intensity: 0.45, dash: 0.025 };
      specs[L.base] = {
        points: new Float32Array([0, 0, SPAN_H, 0]),
        colour: C.grid,
        width: 1,
        intensity: 0.3,
      };
      specs[L.curveM2] = { points: flat(curves.m2), colour: C.m2, width: 2, intensity: 0.75 };
      specs[L.ghostM2] = { points: flat(curves.m2), colour: C.m2, width: 1.3, intensity: 0.32 };
      specs[L.curveBoth] = { points: flat(curves.both), colour: C.sum, width: 2, intensity: 0.75 };
      specs[L.envUp] = { points: flat(curves.env), colour: C.s2, width: 1.6, intensity: 0.8 };
      specs[L.envDn] = { points: flat(curves.env, -1), colour: C.s2, width: 1.6, intensity: 0.8 };
      specs[L.sumRing] = { points: circle, colour: C.sum, width: 1.6, intensity: 0.7, closed: true };
      specs[L.timeAxis] = {
        points: new Float32Array([0, 0, SPAN_H, 0]),
        colour: C.grid,
        width: 1,
        intensity: 0.45,
      };
      specs[L.orbit] = { points: circle, colour: C.moon, width: 1, intensity: 0.4, closed: true, dash: 0.03 };
      specs[L.sunAxis] = {
        points: new Float32Array([-1.6, 0, 1.25, 0]),
        colour: C.s2,
        width: 1,
        intensity: 0.35,
        dash: 0.03,
      };
      specs[L.bulgeM] = { points: circle, colour: C.m2, width: 1.8, intensity: 0.85, closed: true };
      specs[L.bulgeS] = { points: circle, colour: C.s2, width: 1.8, intensity: 0.85, closed: true };
      specs[L.earth] = { points: circle, colour: C.earth, width: 1.2, intensity: 0.7, closed: true };
      days.forEach(
        (d) =>
          (specs[L.dayTick0 + d] = {
            points: new Float32Array([d * 24, 0, d * 24, -1]),
            colour: C.grid,
            width: 1,
            intensity: 0.45,
          }),
      );
      phases.forEach(
        (p, i) =>
          (specs[phaseTick0 + i] = {
            points: new Float32Array([p.hours, 1, p.hours, -1]),
            colour: PAL.light,
            width: 1.1,
            intensity: 0.5,
            dash: 0.022,
          }),
      );
      lines = createLines(specs, { resolution: ctx.globals.uResolution });
      scene.add(lines.mesh);
      disposers.push(lines.dispose);

      dots = createEvents(
        kit,
        [
          { p: [0, 0, 0], colour: C.sum, size: 0.05, intensity: 1.6 }, // pen
          { p: [0, 0, 0], colour: C.m2, size: 0.04, intensity: 1.2 }, // M2 tip
          { p: [0, 0, 0], colour: C.s2, size: 0.045, intensity: 1.5 }, // S2 tip
          { p: [0, 0, 0], colour: C.s2, size: 0.035, intensity: 1.2 }, // envelope pen
          { p: [0, 0, 0], colour: PAL.sun, size: 0.2, intensity: 2.2 }, // Sun
          { p: [0, 0, 0], colour: C.earth, size: 0.05, intensity: 1.4 }, // Earth
          { p: [0, 0, 0], colour: C.moon, size: 0.045, intensity: 1.6 }, // Moon
          { p: [0, 0, 0], colour: C.sum, size: 0.03, intensity: 1.0 }, // dial centre
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
      state = sunState(local);
      const s = state;
      arms(s.hours, r);
      const { cx, cy, k, x0, x1 } = lay;
      const st = lines.state;
      const D2R = Math.PI / 180;

      // Camera: a breath of parallax.
      camera.position.set(Math.sin(elapsed * 0.05) * 0.03, Math.sin(elapsed * 0.037 + 1) * 0.02, D);
      camera.lookAt(0, 0, 0);

      // Dial frame: fixed, or riding along with M2 (see script).
      const hold = arms(FIRST_WINDOW_H, holdArms);
      const a0 = wrap180(hold.m2);
      const rho = s.frame <= 0 ? 0 : s.frame * a0 + (r.m2 - hold.m2);
      const thM = (r.m2 - rho) * D2R;
      const thS = (r.s2 - rho) * D2R;
      const aM = thM + Math.PI / 2;
      const aS = thS + Math.PI / 2;
      const show = s.m2;
      const s2on = s.s2;
      const mx = cx + k * r.fm2 * Math.cos(aM);
      const my = cy + k * r.fm2 * Math.sin(aM);
      const sl = k * r.fs2 * s2on;
      const tx = mx + sl * Math.cos(aS);
      const ty = my + sl * Math.sin(aS);

      const frameOn = 0.4 + 0.6 * show;
      const ring = (i: number, radius: number, on: number) => {
        Object.assign(st[i]!, { x: cx, y: cy, sx: k * radius, sy: k * radius, intensity: on });
      };
      ring(L.ringSpring, r.fm2 + r.fs2, show * (0.3 + 0.7 * s.envelope) * s2on);
      ring(L.ringNeap, r.fm2 - r.fs2, show * (0.3 + 0.7 * s.envelope) * s2on);
      ring(L.ringM2, r.fm2, frameOn * (1 - s2on * 0.6));
      Object.assign(st[L.axisH]!, { x: cx, y: cy, sx: k * 0.82, sy: 1, intensity: frameOn });
      Object.assign(st[L.axisV]!, { x: cx, y: cy, sx: 1, sy: k * 0.82, intensity: frameOn });
      Object.assign(st[L.armM2]!, { x: cx, y: cy, sx: k * r.fm2, sy: k * r.fm2, rot: aM, intensity: show });
      Object.assign(st[L.armS2]!, { x: mx, y: my, sx: sl, sy: sl, rot: aS, intensity: s2on });
      const sumLen = Math.hypot(tx - cx, ty - cy);
      const sumA = Math.atan2(ty - cy, tx - cx);
      Object.assign(st[L.armSum]!, {
        x: cx,
        y: cy,
        sx: sumLen,
        sy: sumLen,
        rot: sumA,
        intensity: s2on * (0.5 + 0.7 * s.frame),
      });
      ring(L.sumRing, r.sum, s.frame * s2on);

      // Chart: three days, then the month (denser, so dimmer and finer).
      const zoom = smooth(s.zoomOut);
      const span = FIRST_WINDOW_H + (SPAN_H - FIRST_WINDOW_H) * zoom;
      const xs = (x1 - x0) / span;
      const toX = (h: number) => x0 + h * xs;
      const reveal = s.hours / SPAN_H;
      const join = (S2_JOIN_H - 6) / SPAN_H;
      const dense = 1 - 0.6 * zoom;
      const curve = (i: number, from: number, to: number, on: number, head = 0.6) => {
        Object.assign(st[i]!, {
          x: x0,
          y: cy,
          sx: xs,
          sy: k,
          from,
          to: Math.max(from, to),
          intensity: on,
          head,
          width: 1 - 0.3 * zoom,
        });
      };
      curve(L.curveM2, 0, Math.min(reveal, join), show * dense, reveal < join ? 0.6 : 0);
      curve(L.curveBoth, join, reveal, show * dense);
      curve(L.ghostM2, join, reveal, show * s2on * (1 - 0.8 * zoom), 0);
      curve(L.envUp, 0, reveal, s.envelope, 0);
      curve(L.envDn, 0, reveal, s.envelope, 0);
      Object.assign(st[L.base]!, {
        x: x0,
        y: cy,
        sx: xs,
        sy: 1,
        from: 0,
        to: Math.min(1, span / SPAN_H),
        intensity: frameOn,
      });
      const axisY = cy - k * 0.86;
      Object.assign(st[L.timeAxis]!, {
        x: x0,
        y: axisY,
        sx: xs,
        sy: 1,
        from: 0,
        to: Math.min(1, span / SPAN_H),
        intensity: frameOn,
      });
      const every = zoom > 0.5 ? (lay.portrait ? 14 : 7) : 1;
      for (const d of days) {
        const on = d * 24 <= span + 1e-6 && d % every === 0 ? frameOn : 0;
        Object.assign(st[L.dayTick0 + d]!, { x: x0, y: axisY, sx: xs, sy: 0.022, intensity: on });
        labels.place(LB[`d${d}`]!, toX(d * 24), axisY - 0.03, 0, camera, on * 0.85);
      }
      phases.forEach((p, i) => {
        const on = s.phases;
        Object.assign(st[phaseTick0 + i]!, { x: x0, y: cy, sx: xs, sy: k * 0.8, intensity: on });
        labels.place(LB[`ph${i}`]!, toX(p.hours), axisY - 0.075, 0, camera, on);
      });
      const rowY = cy + k * 0.8;
      springs.forEach((e, i) => {
        const on = s.envelope * (e.hours <= s.hours + 6 ? 1 : 0);
        labels.place(LB[`sn${i}`]!, toX(e.hours), rowY, 0, camera, on);
      });

      // Pen and projection: the tip's height is the tide (fixed frame); riding along with M2, the sum's length is the
      // envelope, so the guide moves to the top of the sum circle.
      const px = toX(s.hours);
      const py = cy + k * (r.hm2 + r.hs2 * s2on);
      const envY = cy + k * r.sum;
      const fx = s.frame;
      const gx = tx + (cx - tx) * fx;
      const gy = ty + (envY - ty) * fx;
      Object.assign(st[L.proj]!, { x: gx, y: gy, sx: px - gx, sy: 1, rot: 0, intensity: show });

      // Sky sketch (Sun–Earth–Moon, top view; the Sun is off to the left).
      const { ix, iy, is } = lay;
      const sky = s.sky;
      const el = r.elongation * D2R;
      const moonA = Math.PI + el;
      const re = params.insetEarth;
      const eb = params.insetBulge;
      Object.assign(st[L.orbit]!, { x: ix, y: iy, sx: is, sy: is, intensity: sky });
      Object.assign(st[L.sunAxis]!, { x: ix, y: iy, sx: is, sy: is, intensity: sky });
      Object.assign(st[L.earth]!, { x: ix, y: iy, sx: is * re, sy: is * re, intensity: sky });
      Object.assign(st[L.bulgeM]!, {
        x: ix,
        y: iy,
        sx: is * re * (1 + eb * MOON_BULGE_M),
        sy: is * re * (1 - (eb * MOON_BULGE_M) / 2),
        rot: moonA,
        intensity: sky,
      });
      Object.assign(st[L.bulgeS]!, {
        x: ix,
        y: iy,
        sx: is * re * (1 + eb * SUN_BULGE_M),
        sy: is * re * (1 - (eb * SUN_BULGE_M) / 2),
        rot: 0,
        intensity: sky,
      });
      lines.commit();

      // Dots.
      dots.setPos(0, px, py, 0);
      dots.setIntensity(0, 1.4 * show);
      dots.setPos(1, mx, my, 0);
      dots.setIntensity(1, 1.2 * show);
      dots.setPos(2, tx, ty, 0);
      dots.setIntensity(2, 1.5 * s2on);
      dots.setPos(3, px, envY, 0);
      dots.setIntensity(3, 1.2 * s.envelope);
      dots.setPos(4, ix - is * 1.75, iy, 0);
      dots.setIntensity(4, 2.2 * sky);
      dots.setPos(5, ix, iy, 0);
      dots.setIntensity(5, 1.0 * sky);
      dots.setPos(6, ix + is * Math.cos(moonA), iy + is * Math.sin(moonA), 0);
      dots.setIntensity(6, 1.6 * sky);
      dots.setPos(7, cx, cy, 0);
      dots.setIntensity(7, show);
      dots.commit();

      // Labels: M2 beside its arm, S2 just beyond the tip.
      const mlx = cx + k * r.fm2 * 0.55 * Math.cos(aM) - 0.07 * Math.sin(aM);
      const mly = cy + k * r.fm2 * 0.55 * Math.sin(aM) + 0.07 * Math.cos(aM);
      labels.place(LB.m2!, mlx, mly, 0, camera, show * (1 - s.frame * 0.4));
      const tr = sumLen + 0.08;
      labels.place(
        LB.s2!,
        cx + tr * Math.cos(sumA),
        cy + tr * Math.sin(sumA),
        0,
        camera,
        s2on * (1 - s.frame),
      );
      labels.place(LB.sum!, cx, envY + 0.05, 0, camera, s.frame * s2on);
      labels.place(LB.chart!, x0, cy + k * 0.98, 0, camera, frameOn * 0.9);
      labels.place(LB.sunL!, ix - is * 1.75, iy - 0.09, 0, camera, sky);
      labels.place(LB.moonL!, ix + is * Math.cos(moonA) + 0.02, iy + is * Math.sin(moonA), 0, camera, sky);
    },

    render(target: RenderTarget) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },

    resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      lay = layout(camera.aspect);
      phases.forEach((p, i) =>
        labels.setText(
          LB[`ph${i}`]!,
          (lay.portrait ? PHASE_SHORT : PHASE_TEXT)[p.kind as keyof typeof PHASE_TEXT],
        ),
      );
    },

    dispose() {
      for (const d of disposers) d();
    },
  };

  const holdArms = {} as Arms;
  return self;
}

function wrap180(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Positions in world units: the view spans y ∈ [−1, 1] and x ∈ [−aspect, aspect] at z = 0. */
function layout(aspect: number): Layout {
  if (aspect >= 1) {
    const hw = aspect;
    const cx = -hw + Math.min(0.75, hw * 0.36);
    return {
      cx,
      cy: 0.16,
      k: 0.52,
      x0: cx + 0.5,
      x1: hw - 0.14,
      ix: hw - 0.52,
      iy: -0.7,
      is: 0.2,
      portrait: false,
    };
  }
  // Portrait (phones): the free band between the dual clock and the captions is about y ∈ [−0.4, 0.66].
  const hw = aspect;
  const cx = -hw + 0.2;
  return {
    cx,
    cy: 0.34,
    k: 0.25,
    x0: cx + 0.23,
    x1: hw - 0.05,
    ix: 0.06,
    iy: -0.2,
    is: 0.13,
    portrait: true,
  };
}
