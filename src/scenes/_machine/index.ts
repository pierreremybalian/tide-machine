// Machine lab (dev only): the brass tide-predicting machine drawing San Francisco's week.
// URL: /dev/scenes/?scene=_machine&local=0.5&config=kelvin|obb. `local` 0–1 is machine time over one week from the
// start of public/data/sf-week.json; the cranks are set for that instant from NOAA's constants (geared drive).

import { Scene, Vector3, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import type { BlockScene, RenderContext } from '../types.ts';
import { createMachine, type BrassMachine } from '../../shared/brass/assembly.ts';
import { createOutline, type Outline } from '../../shared/brass/outline.ts';
import { LabelSet } from '../../shared/gfx/labels.ts';
import { OrbitRig } from '../../shared/gfx/rig.ts';
import type { StationConstants } from '../../tides/predict.ts';
import type { MachineId } from '../../tides/machine.ts';

const params = {
  station: '/data/stations/9414290.json',
  /** Start of the SF week (public/data/sf-week.json). */
  t0: Date.parse('2025-06-01T00:00Z'),
  span: 7 * 86400e3,
  fov: 30,
  /** Orbit: azimuth at local 0.5 (radians; + looks from the pen end), swing across the stage, elevation. */
  az: { kelvin: 0.3, obb: 0.62 },
  swing: 0.36,
  el: 0.14,
  /** How much of the frame the machine may fill (NDC half-extents); portrait crops to the cranks' end and the paper. */
  fill: { x: 0.94, y: 0.86 },
  fillPortrait: { kelvin: { x: 1.75, y: 0.7 }, obb: { x: 2.6, y: 0.7 } },
};

const LABELS = [
  { id: 'throw', text: 'crank throw = amplitude', tone: 'warm', side: 'right' },
  { id: 'angle', text: 'crank angle = phase', tone: 'warm', side: 'left' },
  { id: 'gear', text: 'gear ratio = speed', tone: 'warm', side: 'left' },
  { id: 'wire', text: 'one wire sums them', tone: 'plain', side: 'left' },
  { id: 'pen', text: 'the pen draws the tide', tone: 'plain', side: 'right' },
] as const;
type LabelId = (typeof LABELS)[number]['id'];
const flip = (side: string) => (side === 'left' ? 'right' : side === 'right' ? 'left' : side) as 'left' | 'right' | 'above';

export default function makeMachineScene(): BlockScene {
  let renderer: WebGPURenderer;
  let scene: Scene;
  let overlay: Scene;
  let rig: OrbitRig;
  let machine: BrassMachine;
  let outline: Outline;
  let config: MachineId = 'kelvin';
  let labels = new LabelSet(LABELS.map((l) => ({ ...l })));
  let L = {} as Record<LabelId, number>;
  /** First label index of the per-pulley constituent names. */
  let names = 0;
  /** Cranks whose degree circle and train carry the phase and gear labels: the first of each row in landscape (at
   * the left, clear of the record), the last but one in portrait (the end that stays in frame). */
  const pick = { landscape: { lower: 0, upper: 0 }, portrait: { lower: 0, upper: 0 } };
  let dist = 10;
  const v = new Vector3();
  const pa = new Vector3();
  const pb = new Vector3();
  const corner = new Vector3();

  const self: BlockScene = {
    id: '_machine',
    status: 'historical',
    statusNote: 'Lab: the machine’s mechanism is computed (crank settings from NOAA’s San Francisco constants, gear trains with real tooth counts); one week of machine time across the stage.',
    labels,
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
      config = q.get('config') === 'obb' ? 'obb' : 'kelvin';
      const station = await ctx.assets.json<StationConstants>(params.station);
      scene = new Scene();
      overlay = new Scene();
      rig = new OrbitRig(params.fov);
      machine = createMachine(ctx, { machine: config, station, t0: params.t0, span: params.span });
      scene.add(machine.solids);
      overlay.add(machine.overlay);
      // Fixed labels, then one small name per pulley (shown where the pulleys are big enough on screen).
      // Each fixed label also exists on the other side, shown instead when the text would run off screen.
      labels = new LabelSet([
        ...LABELS.map((l) => ({ ...l })),
        ...LABELS.map((l) => ({ ...l, id: `${l.id}~`, side: flip(l.side) })),
        ...machine.model.cranks.map((c) => ({ id: `n${c.index}`, text: c.name, tone: 'mute' as const, side: 'center' as const, size: 'sm' as const })),
      ]);
      self.labels = labels;
      L = Object.fromEntries(LABELS.map((l) => [l.id, labels.index(l.id)])) as Record<LabelId, number>;
      names = LABELS.length * 2;
      // The featured crank (largest throw) and its chain glow a little hotter: the labels point at it.
      const fp = machine.crankParts[machine.featured]!;
      machine.setHot(fp[0], fp[1], fp[2]);
      const cr = machine.model.cranks;
      pick.landscape.lower = cr.find((c) => c.row < 0)!.index;
      pick.landscape.upper = cr.find((c) => c.row > 0)!.index;
      // In portrait the phase label moves up to the last upper crank, away from the throw label below.
      pick.portrait.lower = cr.filter((c) => c.row > 0).at(-1)!.index;
      pick.portrait.upper = cr.filter((c) => c.row > 0).at(-2)!.index;
      outline = createOutline(renderer, scene, rig.camera, { resolutionScale: ctx.quality.renderScale });
      self.update(0.5, 0, 0);
      await outline.compile(overlay);
    },
    update(local: number, _dt: number, elapsed: number) {
      const ms = params.t0 + Math.min(1, Math.max(0, local)) * params.span;
      machine.update(ms);
      // Frame the machine: a slow swing with the stage plus the rig's idle drift; the distance is refined by
      // projecting the bounds' corners so the whole machine fits whatever the angle and aspect.
      const b = machine.bounds;
      const cam = rig.camera;
      const portrait = cam.aspect < 1;
      const az = (portrait ? Math.min(0.75, params.az[config] * 2.4) : params.az[config]) + params.swing * (local - 0.5);
      const fill = portrait ? params.fillPortrait[config] : params.fill;
      // Portrait: centre on where the wire leaves the last pulley for the paper.
      const tx = portrait ? machine.locate('run', machine.model.cranks.length - 1, v).x : b.centre.x;
      for (let it = 0; it < 4; it++) {
        rig.apply({ az, el: params.el, dist: dist / rig.fit(), tx, tt: b.centre.y, ty: b.centre.z }, elapsed);
        cam.updateMatrixWorld();
        let mx = 0;
        let my = 0;
        for (let c = 0; c < 8; c++) {
          corner.set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z).project(cam);
          mx = Math.max(mx, Math.abs(corner.x));
          my = Math.max(my, Math.abs(corner.y));
        }
        const k = Math.max(mx / fill.x, my / fill.y);
        if (Math.abs(k - 1) < 0.01) break;
        dist *= k;
      }

      const m = machine;
      const f = m.featured;
      const cssW = typeof window === 'undefined' ? 1280 : window.innerWidth;
      const put = (id: LabelId, p: Vector3) => {
        const i = L[id];
        const spec = LABELS[i]!;
        const px = ((pa.copy(p).project(cam).x + 1) / 2) * cssW;
        const textW = spec.text.length * 6.6 + 14;
        const off = spec.side === 'left' ? px - textW < 6 : spec.side === 'right' ? px + textW > cssW - 6 : false;
        labels.place(off ? i + LABELS.length : i, p.x, p.y, p.z, cam, 1);
        labels.hide(off ? i : i + LABELS.length);
      };
      put('throw', m.locate('pin', f, v));
      const pk = portrait ? pick.portrait : pick.landscape;
      put('gear', m.locate('train', pk.upper, v).setX(v.x - m.discRadius - 0.08));
      put('angle', m.locate('ring', pk.lower, v));
      if (portrait) put('wire', m.locate('run', pk.upper, v));
      else put('wire', m.locate('anchor', 0, v).setY(v.y - 0.15));
      put('pen', m.locate('pen', 0, v));
      // Names inside the pulleys, faded out where a pulley is under ~24 px across.
      for (let i = 0; i < m.model.cranks.length; i++) {
        m.locate('pulley', i, v);
        pa.copy(v).project(cam);
        pb.copy(v).setX(v.x + m.pulleyRadius).project(cam);
        const px = Math.abs(pb.x - pa.x) * 0.5 * cssW;
        labels.place(names + i, v.x, v.y, v.z, cam, Math.min(1, Math.max(0, (px - 12) / 6)) * 0.85);
      }
    },
    render(target: RenderTarget) {
      outline.render(target, overlay);
    },
    resize(width: number, height: number, dpr: number) {
      rig.resize(width, height);
      outline.setSize(width, height, dpr);
    },
    dispose() {
      machine.dispose();
      outline.dispose();
      scene.clear();
      overlay.clear();
    },
  };
  return self;
}
