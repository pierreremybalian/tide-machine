// Screenshot harness for scenes and the full page (used for self-testing and stills).
// Usage:
//   node scripts/shoot.ts --url "http://localhost:4330/dev/scenes/?scene=qgp&local=0.5&ui=0" --out shot.png
//   node scripts/shoot.ts --scene qgp --locals 0.1,0.5,0.9 --outdir scratch/shots [--webgl] [--base …] [--leak] [--chapter <id>]
//   node scripts/shoot.ts --page 0,0.3,0.6 --outdir scratch/shots   (full page at scroll progress values)
// Waits for window.__ready (dev route) and prints console errors. Exit code 1 on page errors or scene failure.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? '') : d;
};
const flag = (k: string) => args.includes(`--${k}`);
const base = opt('base', 'http://localhost:4360')!;
const width = Number(opt('width', '1280'));
const height = Number(opt('height', '720'));
const webgl = flag('webgl');
const tier = opt('tier', 'medium');
const timeout = Number(opt('timeout', '90000'));

const jobs: { url: string; out: string }[] = [];
if (opt('url')) jobs.push({ url: opt('url')!, out: opt('out', 'shot.png')! });
if (opt('scene')) {
  const scene = opt('scene')!;
  const outdir = opt('outdir', 'scratch/shots')!;
  for (const l of (opt('locals', '0.1,0.5,0.9') ?? '').split(',')) {
    const chapter = opt('chapter');
    const u = `${base}/dev/scenes/?scene=${scene}&local=${l}&ui=0&tier=${tier}&frames=${opt('frames', '45')}${webgl ? '&webgl=1' : ''}${chapter ? `&chapter=${chapter}` : ''}`;
    jobs.push({ url: u, out: join(outdir, `${scene}${chapter ? `-${chapter}` : ''}-${l}${webgl ? '-webgl' : ''}.png`) });
  }
}
// Full page inside a stage: --stage whose --at 0.2,0.5 (local positions within the stage)
if (opt('stage')) {
  const { stageIndex, stageToProgress } = await import('../src/time/stages.ts');
  const id = opt('stage')!;
  const i = stageIndex(id);
  if (i < 0) throw new Error(`unknown stage ${id}`);
  const outdir = opt('outdir', 'scratch/shots')!;
  for (const l of (opt('at', '0.5') ?? '').split(',')) {
    const p = stageToProgress(i, Number(l));
    jobs.push({ url: `${base}/?tier=${tier}&probe=0${webgl ? '&webgl=1' : ''}#p=${p.toFixed(6)}`, out: join(outdir, `page-${id}-${l}${webgl ? '-webgl' : ''}.png`) });
  }
}
// Full page at given scroll progress values: --page 0,0.25,0.5
if (opt('page')) {
  const outdir = opt('outdir', 'scratch/shots')!;
  for (const p of opt('page')!.split(',')) jobs.push({ url: `${base}/?tier=${tier}${webgl ? '&webgl=1' : ''}#p=${p}`, out: join(outdir, `page-${p}.png`) });
}
if (!jobs.length) {
  console.error('nothing to do; pass --url or --scene');
  process.exit(2);
}

const browser = await chromium.launch({
  headless: !flag('headed'),
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'],
});
let failed = false;
for (const job of jobs) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    // Missing stills (before `pnpm stills` has run) are expected 404s, not scene errors.
    const missingAsset = m.type() === 'error' && /Failed to load resource.*404/.test(t);
    if (missingAsset) return;
    if (m.type() === 'error' || /WebGPU|backend|\[scene|\[quality/.test(t)) console.log(`  [${m.type()}] ${t.slice(0, 400)}`);
    if (m.type() === 'error') errors.push(t);
  });
  page.on('pageerror', (e) => {
    errors.push(String(e));
    console.log(`  [pageerror] ${String(e).slice(0, 600)}`);
  });
  const t0 = Date.now();
  await page.goto(job.url, { waitUntil: 'load', timeout });
  try {
    if (job.url.includes('/dev/scenes')) await page.waitForFunction('window.__ready === true', null, { timeout, polling: 250 });
    else {
      const m = job.url.match(/#p=([\d.]+)/);
      await page.waitForFunction('window.__ready === true || (!!window.__driver && !!window.__engine)', null, { timeout });
      if (m) {
        await page.evaluate((p) => (window as unknown as { __driver: { scrollToProgress(p: number, o: object): void } }).__driver.scrollToProgress(p, { immediate: true }), Number(m[1]));
      }
      await page.waitForTimeout(Number(opt('wait', '4000')));
    }
  } catch {
    console.log('  timeout waiting for __ready');
    failed = true;
  }
  if (flag('leak') && job.url.includes('/dev/scenes')) {
    await page.evaluate("document.querySelector('[data-leak]').click()");
    await page.waitForFunction('!!window.__leak', null, { timeout: timeout * 3, polling: 500 });
    const leak = (await page.evaluate('window.__leak')) as { ok: boolean };
    console.log(`  leak test: ${JSON.stringify(leak)}`);
    if (!leak.ok) failed = true;
  }
  const sceneFailed = await page.evaluate('window.__sceneFailed === true');
  const backend = await page.evaluate('window.__engine ? window.__engine.backend : "none"');
  mkdirSync(dirname(job.out), { recursive: true });
  await page.screenshot({ path: job.out });
  console.log(`${job.out}  (${backend}, ${((Date.now() - t0) / 1000).toFixed(1)} s)${sceneFailed ? '  SCENE FAILED' : ''}${errors.length ? `  ${errors.length} errors` : ''}`);
  if (sceneFailed || errors.length) failed = true;
  await context.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
