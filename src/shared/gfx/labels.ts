// HTML labels anchored to 3D points (HANDOFF §8.9). Text never goes in the canvas: a scene owns a LabelSet, places
// each label every frame by projecting a world point with its camera (no allocation), and the engine writes the
// result into an HTML layer, weighted by the transition mix.

import { Vector3, type Camera } from 'three/webgpu';

export type Tone = 'a' | 'b' | 'both' | 'light' | 'plain' | 'mute' | 'warm' | 'event';
export type Side = 'right' | 'left' | 'above' | 'below' | 'center';

export interface LabelSpec {
  id: string;
  text: string;
  tone?: Tone;
  side?: Side;
  /** 'sm' for small annotations, 'md' for names. */
  size?: 'sm' | 'md';
  /** Keep the text's case in uppercase styles (detected automatically for Greek letters and units). */
  keepCase?: boolean;
}

/** Small labels are uppercased by CSS. Greek letters (ρ1 → Ρ1 reads as P1), µ and units after numbers ("2.1 m")
 * must keep their case. */
export function needsKeepCase(text: string): boolean {
  return /[µμ\u03b1-\u03c9]/.test(text) || /\d\s?(?:m|cm|mm|km|s|h|min|yr|ms|µs)\b/.test(text);
}

export interface LabelState {
  /** Fraction of the viewport from the left. */
  x: number;
  /** Fraction of the viewport from the top. */
  y: number;
  opacity: number;
  /** Bumped when the text changes. */
  rev: number;
}

/** A sub-rectangle of the viewport in fractions, origin top-left (for diptych panels and the loupe). */
export interface Panel {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_PANEL: Panel = { x: 0, y: 0, w: 1, h: 1 };

export class LabelSet {
  readonly specs: LabelSpec[];
  readonly state: LabelState[];
  private readonly v = new Vector3();
  private readonly ids = new Map<string, number>();

  constructor(specs: LabelSpec[]) {
    this.specs = specs.map((s) => ({ ...s }));
    this.state = specs.map(() => ({ x: 0, y: 0, opacity: 0, rev: 0 }));
    this.specs.forEach((s, i) => this.ids.set(s.id, i));
  }

  index(id: string): number {
    const i = this.ids.get(id);
    if (i === undefined) throw new Error(`unknown label ${id}`);
    return i;
  }

  /** Project world point (x, y, z) with `camera` into label i. Hidden when behind the camera or off panel. */
  place(i: number, x: number, y: number, z: number, camera: Camera, opacity = 1, panel: Panel = FULL_PANEL): void {
    const st = this.state[i]!;
    const v = this.v.set(x, y, z).project(camera);
    if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15) {
      st.opacity = 0;
      return;
    }
    st.x = panel.x + ((v.x + 1) / 2) * panel.w;
    st.y = panel.y + ((1 - v.y) / 2) * panel.h;
    st.opacity = opacity;
  }

  /** Place at a fixed screen position (fractions, top-left origin). */
  placeScreen(i: number, x: number, y: number, opacity = 1): void {
    const st = this.state[i]!;
    st.x = x;
    st.y = y;
    st.opacity = opacity;
  }

  setText(i: number, text: string): void {
    const sp = this.specs[i]!;
    if (sp.text === text) return;
    sp.text = text;
    this.state[i]!.rev++;
  }

  hide(i: number): void {
    this.state[i]!.opacity = 0;
  }

  hideAll(): void {
    for (const s of this.state) s.opacity = 0;
  }
}

/** Writes LabelSets into an HTML container. One pool of elements per set. */
export class LabelLayer {
  private readonly pools = new WeakMap<LabelSet, { els: HTMLElement[]; revs: number[] }>();
  private readonly live = new Set<LabelSet>();
  private readonly seen = new Set<LabelSet>();
  private w = 1;
  private h = 1;

  constructor(private readonly root: HTMLElement) {
    this.measure();
  }

  measure(): void {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
  }

  private pool(set: LabelSet) {
    let p = this.pools.get(set);
    if (!p) {
      const els = set.specs.map((sp) => {
        const el = document.createElement('div');
        el.className = `lbl lbl-${sp.side ?? 'right'} lbl-${sp.size ?? 'md'}`;
        el.classList.toggle('lbl-keepcase', sp.keepCase ?? needsKeepCase(sp.text));
        el.dataset.tone = sp.tone ?? 'plain';
        el.innerHTML = `<span>${sp.text}</span>`;
        el.style.opacity = '0';
        this.root.appendChild(el);
        return el;
      });
      p = { els, revs: set.state.map((s) => s.rev) };
      this.pools.set(set, p);
    }
    return p;
  }

  begin(): void {
    this.seen.clear();
  }

  draw(set: LabelSet, weight: number): void {
    const p = this.pool(set);
    this.seen.add(set);
    this.live.add(set);
    for (let i = 0; i < p.els.length; i++) {
      const st = set.state[i]!;
      const el = p.els[i]!;
      if (st.rev !== p.revs[i]) {
        p.revs[i] = st.rev;
        el.innerHTML = `<span>${set.specs[i]!.text}</span>`;
        el.classList.toggle('lbl-keepcase', set.specs[i]!.keepCase ?? needsKeepCase(set.specs[i]!.text));
      }
      const o = st.opacity * weight;
      el.style.opacity = o > 0.001 ? o.toFixed(3) : '0';
      if (o > 0.001) el.style.transform = `translate3d(${(st.x * this.w).toFixed(1)}px, ${(st.y * this.h).toFixed(1)}px, 0)`;
    }
  }

  /** Remove the elements of sets not drawn since begin() (their scene was unloaded or is off screen). */
  end(): void {
    for (const set of this.live) {
      if (this.seen.has(set)) continue;
      const p = this.pools.get(set);
      if (p) for (const el of p.els) el.remove();
      this.pools.delete(set);
      this.live.delete(set);
    }
  }

  clear(): void {
    this.begin();
    this.end();
  }
}
