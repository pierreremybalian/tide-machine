// Blends outgoing and incoming scene targets, then post: bloom → tone map → film grain (HANDOFF §10.4).

import { DataTexture, RenderPipeline, RGBAFormat, type Texture, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, clamp, float, hash, mix, texture, uniform, uv, vec2, vec3, vec4, luminance } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { TransitionKind } from '../time/stages.ts';
import type { GlobalUniforms } from './globals.ts';
import { dissolve } from './transitions/dissolve.ts';
import { zoom } from './transitions/zoom.ts';
import { stretch } from './transitions/stretch.ts';

const KIND: Record<TransitionKind | 'none' | 'fade', number> = { none: 0, dissolve: 1, zoom: 2, stretch: 3, fade: 4 };

export const POST = {
  bloomStrength: 0.6,
  bloomRadius: 0.35,
  bloomThreshold: 0.85,
  grain: 0.022,
  vignette: 0.32,
  exposure: 1.0,
};

export class Compositor {
  private readonly blank: DataTexture;
  private readonly blankA: DataTexture;
  private readonly texA;
  private readonly texB;
  private readonly uMix = uniform(0);
  private readonly uKind = uniform(0);
  private readonly uAspect = uniform(1);
  private readonly uFade = uniform(1);
  private readonly uGrain = uniform(POST.grain);
  readonly bloomNode;
  private readonly pipeline: RenderPipeline;

  constructor(
    private readonly renderer: WebGPURenderer,
    globals: GlobalUniforms,
  ) {
    // Two distinct placeholder textures: if both nodes start on the same texture, three shares the binding and
    // later value swaps are ignored (found the hard way: black frames).
    this.blank = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat);
    this.blank.needsUpdate = true;
    this.blankA = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat);
    this.blankA.needsUpdate = true;
    this.texA = texture(this.blankA);
    this.texB = texture(this.blank);
    const { texA, texB, uMix, uKind, uAspect, uFade, uGrain } = this;
    const time = globals.uElapsed;

    const composite = Fn(() => {
      const p = uv();
      const col = vec4(0).toVar();
      If(uKind.equal(KIND.dissolve), () => {
        col.assign(dissolve(texA, texB, p, uMix, time, uAspect));
      })
        .ElseIf(uKind.equal(KIND.zoom), () => {
          col.assign(zoom(texA, texB, p, uMix, uAspect));
        })
        .ElseIf(uKind.equal(KIND.stretch), () => {
          col.assign(stretch(texA, texB, p, uMix));
        })
        .ElseIf(uKind.equal(KIND.fade), () => {
          col.assign(mix(texA.sample(p), texB.sample(p), uMix));
        })
        .Else(() => {
          col.assign(texB.sample(p));
        });
      // Clamp guards bloom against NaN/inf from any scene (one bad pixel would black out the frame) and fireflies.
      return vec4(clamp(col.rgb, 0, 64).mul(uFade), 1);
    })();

    this.bloomNode = bloom(composite, POST.bloomStrength, POST.bloomRadius, POST.bloomThreshold);
    const graded = Fn(() => {
      const p = uv();
      const c = composite.rgb.add(this.bloomNode.rgb).toVar();
      // Vignette, very soft.
      const d = p.sub(0.5).mul(vec2(uAspect, 1)).length();
      c.mulAssign(float(1).sub(d.mul(d).mul(POST.vignette)));
      // Film grain: luminance-weighted so blacks stay black.
      const px = p.mul(globals.uResolution).floor();
      const g = hash(px.x.add(px.y.mul(1031.0)).add(time.mul(60.0).floor().mul(7919.0))).sub(0.5);
      const l = luminance(c).add(0.02).sqrt();
      c.addAssign(vec3(g.mul(uGrain).mul(l)));
      return vec4(c.max(0), 1);
    })();
    this.pipeline = new RenderPipeline(renderer, graded);
  }

  setSize(width: number, height: number): void {
    this.uAspect.value = width / Math.max(1, height);
  }

  setBloom(strength: number): void {
    this.bloomNode.strength.value = strength;
  }

  /**
   * incoming: the active scene's output. outgoing: previous scene during a transition (or null).
   * mix ∈ [0,1]; fade multiplies the final image (used while a scene is still loading).
   */
  render(incoming: Texture | null, outgoing: Texture | null, mixT: number, kind: TransitionKind | 'none' | 'fade', fade = 1): void {
    this.texB.value = incoming ?? this.blank;
    this.texA.value = outgoing ?? this.blankA;
    this.uMix.value = mixT;
    this.uKind.value = outgoing ? KIND[kind] : 0;
    this.uFade.value = fade;
    this.renderer.setRenderTarget(null);
    this.pipeline.render();
  }

  dispose(): void {
    this.pipeline.dispose();
    this.bloomNode.dispose();
    this.blank.dispose();
    this.blankA.dispose();
  }
}
