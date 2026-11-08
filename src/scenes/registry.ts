// Scene id → lazy module, discovered from src/scenes/<id>/index.ts (each default-exports a SceneFactory).
// Stages without a scene yet fall back to the placeholder.
import type { SceneFactory } from './types.ts';
import { STAGES } from '../time/stages.ts';

type Loader = () => Promise<{ default: SceneFactory }>;

const found = import.meta.glob<{ default: SceneFactory }>('./*/index.ts');
const BUILT: Record<string, Loader> = Object.fromEntries(
  Object.entries(found).map(([path, load]) => [path.split('/')[1]!, load as Loader]),
);

const stub = (id: string): Loader => async () => {
  const { makePlaceholder } = await import('./_placeholder/index.ts');
  const st = STAGES.find((s) => s.id === id);
  return { default: () => makePlaceholder({ id, status: st?.status }) };
};

export const SCENES: Record<string, Loader> = Object.fromEntries([
  ...STAGES.map((s) => [s.sceneId, BUILT[s.sceneId] ?? stub(s.sceneId)] as const),
  ...Object.entries(BUILT).filter(([id]) => !STAGES.some((s) => s.sceneId === id)),
]);

export const SCENE_IDS = STAGES.map((s) => s.sceneId);
