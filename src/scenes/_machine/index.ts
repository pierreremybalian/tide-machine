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
  /** How much of the frame the machine may fill (NDC half-extents). */
  fill: { x: 0.94, y: 0.86 },
};

const LABELS = [
  { id: 'throw', text: 'crank throw = amplitude', tone: 'warm', side: 'right' },
  { id: 'angle', text: 'crank angle = phase', tone: 'warm', side: 'left' },
  { id: 'gear', text: 'gear ratio = speed', tone: 'warm', side: 'left' },
  { id: 'wire', text: 'one wire sums them', tone: 'plain', side: 'left' },
  { id: 'pen', text: 'the pen draws the tide', tone: 'plain', side: 'right' },
] as const;
type LabelId = (typeof LABELS)[number]['id'];

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
  /** The first crank of each row: the lower one's degree circle carries the phase label, the upper one's train the
   * gear label (both at the left, clear of the record). */
  let firstLower = 0;
  let firstUpper = 0;
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
      labels = new LabelSet([
        ...LABELS.map((l) => ({ ...l })),
        ...machine.model.cranks.map((c) => ({ id: `n${c.index}`, text: c.name, tone: 'mute' as const, side: 'center' as const, size: 'sm' as const })),
      ]);
      self.labels = labels;
      L = Object.fromEntries(LABELS.map((l) => [l.id, labels.index(l.id)])) as Record<LabelId, number>;
      names = LABELS.length;
      firstLower = machine.model.cranks.find((c) => c.row < 0)!.index;
      firstUpper = machine.model.cranks.find((c) => c.row > 0)!.index;
      outline = createOutline(renderer, scene, rig.camera, { resolutionScale: ctx.quality.renderScale });
      self.update(0.5, 0, 0);
      await renderer.compileAsync(overlay, rig.camera);
    },
    update(local: number, _dt: number, elapsed: number) {
      const ms = params.t0 + Math.min(1, Math.max(0, local)) * params.span;
      machine.update(ms);
      // Frame the machine: a slow swing with the stage plus the rig's idle drift; the distance is refined by
      // projecting the bounds' corners so the whole machine fits whatever the angle and aspect.
      const b = machine.bounds;
      const cam = rig.camera;
      const portrait = cam.aspect < 1;
      const az = params.az[config] * (portrait ? 1.7 : 1) + params.swing * (local - 0.5);
      for (let it = 0; it < 4; it++) {
        rig.apply({ az, el: params.el, dist: dist / rig.fit(), tx: b.centre.x, tt: b.centre.y, ty: b.centre.z }, elapsed);
        cam.updateMatrixWorld();
        let mx = 0;
        let my = 0;
        for (let c = 0; c < 8; c++) {
          corner.set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z).project(cam);
          mx = Math.max(mx, Math.abs(corner.x));
          my = Math.max(my, Math.abs(corner.y));
        }
        const k = Math.max(mx / params.fill.x, my / params.fill.y);
        if (Math.abs(k - 1) < 0.01) break;
        dist *= k;
      }

      const m = machine;
      const f = m.featured;
      const put = (id: LabelId, p: Vector3) => labels.place(L[id], p.x, p.y, p.z, cam, 1);
      put('throw', m.locate('pin', f, v));
      put('gear', m.locate('train', firstUpper, v).setX(v.x - m.discRadius - 0.08));
      put('angle', m.locate('ring', firstLower, v));
      put('wire', m.locate('anchor', 0, v).setY(v.y - 0.15));
      put('pen', m.locate('pen', 0, v));
      // Names inside the pulleys, faded out where a pulley is under ~24 px across.
      const cssW = typeof window === 'undefined' ? 1280 : window.innerWidth;
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
