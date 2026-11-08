// Placeholder scene: a slowly breathing gradient. Also the quality probe and the stub for unbuilt stages.

import { Mesh, MeshBasicNodeMaterial, PerspectiveCamera, PlaneGeometry, Scene, type RenderTarget, type WebGPURenderer } from 'three/webgpu';
import { float, mix, mx_noise_float, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { fbm } from '../../shared/noise.ts';
import type { BlockScene, RenderContext, Status } from '../types.ts';

export interface PlaceholderOptions {
  id: string;
  status?: Status;
  statusNote?: string;
  /** Heavier shader for the quality probe. */
  probe?: boolean;
  hue?: [number, number, number];
}

export function makePlaceholder(o: PlaceholderOptions): BlockScene {
  let renderer: WebGPURenderer;
  let scene: Scene;
  let camera: PerspectiveCamera;
  let mesh: Mesh;
  const uLocal = uniform(0);
  const self: BlockScene = {
    id: o.id,
    status: o.status ?? 'metaphor',
    statusNote: o.statusNote ?? 'Placeholder visual while this scene is built.',
    async init(ctx: RenderContext) {
      renderer = ctx.renderer;
      scene = new Scene();
      camera = new PerspectiveCamera(40, 1, 0.1, 100);
      camera.position.set(0, 0, 6);
      const g = ctx.globals;
      const p = vec3(uv().mul(3), g.uElapsed.mul(0.05));
      const n = o.probe ? fbm(p, 8) : mx_noise_float(p).mul(0.5);
      const [r, gg, b] = o.hue ?? [0.35, 0.3, 0.8];
      const base = mix(vec3(0.01, 0.01, 0.03), vec3(r, gg, b), n.mul(0.5).add(0.5));
      const d = uv().sub(0.5).length();
      const glow = float(1).sub(smoothstep(0.0, 0.75, d)).mul(float(0.5).add(uLocal.mul(0.4)));
      const mat = new MeshBasicNodeMaterial();
      mat.colorNode = base.mul(glow);
      mesh = new Mesh(new PlaneGeometry(16, 9), mat);
      scene.add(mesh);
      await renderer.compileAsync(scene, camera);
    },
    update(local: number) {
      uLocal.value = local;
      mesh.rotation.z = local * 0.2;
    },
    render(target: RenderTarget) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },
    resize(width: number, height: number) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    dispose() {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicNodeMaterial).dispose();
    },
  };
  return self;
}

export default () => makePlaceholder({ id: '_placeholder' });
