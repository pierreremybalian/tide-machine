// End-to-end check of the finale (HANDOFF §14): load the page with a shared link (Boston, a NOAA station: measured),
// wait for the live coast, screenshot; go back to the globe, search "Lisbon" (EOT20: modelled), screenshot; and check
// the numbers on the place card against src/tides/predict.ts, computed here independently from the same sources
// (NOAA's API for the station, the EOT20 tiles served by the dev server for the model).
// Usage: node scripts/finale-check.ts [--base http://localhost:4360] [--outdir scratch/shots/finale] [--width 1280 --height 720] [--webgl]

import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { prepare, predict } from '../src/tides/predict.ts';
import { asStationConstants, tideSource } from '../src/finale/source.ts';
import { nextExtremes, tideSeries } from '../src/finale/extremes.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const base = opt('base', 'http://localhost:4360');
const outdir = opt('outdir', 'scratch/shots/finale');
const width = Number(opt('width', '1280'));
const height = Number(opt('height', '720'));
const webgl = args.includes('--webgl');
mkdirSync(outdir, { recursive: true });

const fetchAbs = (u: string, i?: { signal?: AbortSignal }) => fetch(u.startsWith('/') ? `${base}${u}` : u, i);

interface Shown {
  source: string;
  kind: string;
  lat: number;
  lng: number;
  now: number;
  nowText: string;
  ms: number;
  highT: number;
  high: number;
  lowT: number;
  low: number;
  building: string;
  chip: string;
}

async function readCard(page: Page): Promise<Shown> {
  return page.evaluate(() => {
    const q = (s: string) => document.querySelector<HTMLElement>(`[data-finale] ${s}`)!;
    const card = q('[data-card]');
    return {
      source: card.dataset.source ?? '',
      kind: card.dataset.kind ?? '',
      lat: Number(card.dataset.lat),
      lng: Number(card.dataset.lng),
      now: Number(q('[data-now]').dataset.value),
      nowText: q('[data-now]').textContent ?? '',
      ms: Number(q('[data-now]').dataset.ms),
      highT: Number(q('[data-high]').dataset.t),
      high: Number(q('[data-high]').dataset.value),
      lowT: Number(q('[data-low]').dataset.t),
      low: Number(q('[data-low]').dataset.value),
      building: q('[data-building]').textContent ?? '',
      chip: document.querySelector('[data-acc-label]')?.textContent ?? '',
    };
  });
}

async function waitForPlace(page: Page, label: string) {
  try {
    await page.waitForFunction(() => {
      const c = document.querySelector<HTMLElement>('[data-finale] [data-card]');
      const b = document.querySelector<HTMLElement>('[data-finale] [data-building]');
      return !!c && !c.hidden && !!c.dataset.source && !!b && b.textContent === '';
    }, null, { timeout: 90_000 });
  } catch (err) {
    await page.screenshot({ path: join(outdir, `${label}-timeout.png`) });
    const st = await page.evaluate(() => ({
      phase: document.querySelector<HTMLElement>('[data-finale]')?.dataset.phase,
      status: document.querySelector('[data-finale] [data-status]')?.textContent,
      building: document.querySelector('[data-finale] [data-building]')?.textContent,
      error: document.querySelector('[data-finale] [data-error-msg]')?.textContent,
      source: document.querySelector<HTMLElement>('[data-finale] [data-card]')?.dataset.source,
    }));
    console.log(`  timeout waiting for ${label}: ${JSON.stringify(st)}`);
    throw err;
  }
  await page.waitForTimeout(3500); // the dip into the coast and a few frames
  const shot = join(outdir, `${label}-${width}x${height}${webgl ? '-webgl' : ''}.png`);
  await page.screenshot({ path: shot });
  return shot;
}

let failed = false;
async function verify(label: string, s: Shown) {
  if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng) || !Number.isFinite(s.ms)) {
    failed = true;
    console.log(`\n${label}: FAIL the card carries no place (${JSON.stringify(s)})`);
    return;
  }
  const src = await tideSource(s.lat, s.lng, { fetch: fetchAbs });
  const p = prepare(asStationConstants(src));
  const ours = predict(p, s.ms);
  const series = tideSeries(p, s.ms - 86400e3, s.ms + 3 * 86400e3);
  const nx = nextExtremes(series, s.ms);
  const rows: [string, string, string, number, number][] = [
    ['now (m)', s.now.toFixed(4), ours.toFixed(4), Math.abs(s.now - ours), 0.0005],
    ['next high (m)', s.high.toFixed(4), (nx.high?.h ?? NaN).toFixed(4), Math.abs(s.high - (nx.high?.h ?? NaN)), 0.0005],
    ['next high (min)', new Date(s.highT).toISOString().slice(11, 16), new Date(nx.high?.t ?? 0).toISOString().slice(11, 16), Math.abs(s.highT - (nx.high?.t ?? 0)) / 60e3, 1],
    ['next low (m)', s.low.toFixed(4), (nx.low?.h ?? NaN).toFixed(4), Math.abs(s.low - (nx.low?.h ?? NaN)), 0.0005],
    ['next low (min)', new Date(s.lowT).toISOString().slice(11, 16), new Date(nx.low?.t ?? 0).toISOString().slice(11, 16), Math.abs(s.lowT - (nx.low?.t ?? 0)) / 60e3, 1],
  ];
  const shownRounded = Number(s.nowText.replace('−', '-').replace(/[^\d.-]/g, ''));
  rows.push(['now as shown (m)', s.nowText, ours.toFixed(2), Math.abs(shownRounded - ours), 0.0051]);
  console.log(`\n${label}: ${src.kind} · source ${src.id}${src.station ? ` (${src.station.name})` : ''} · ${src.datumLabel} · chip "${s.chip}" · page source ${s.source}`);
  for (const [k, a, b, d, tol] of rows) {
    const ok = d <= tol;
    if (!ok) failed = true;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k.padEnd(18)} page ${a.padStart(9)}   predict() ${b.padStart(9)}   |Δ| ${d.toFixed(4)}`);
  }
  if (src.id !== s.source) {
    failed = true;
    console.log(`  FAIL source mismatch: page ${s.source}, check ${src.id}`);
  }
  const wantChip = src.kind === 'measured' ? 'Measured' : 'Modeled';
  if (s.chip !== wantChip) {
    failed = true;
    console.log(`  FAIL status chip "${s.chip}", expected "${wantChip}"`);
  }
}

const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'],
});
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => {
  errors.push(String(e));
  console.log(`  [pageerror] ${String(e).slice(0, 400)}`);
});
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) {
    errors.push(m.text());
    console.log(`  [console] ${m.text().slice(0, 400)}`);
  }
});

// 1. A shared link: Boston (NOAA 8443970, measured, live gauge).
await page.goto(`${base}/?tier=medium&probe=0${webgl ? '&webgl=1' : ''}&lat=42.3539&lng=-71.0503&name=Boston`, { waitUntil: 'load' });
const shot1 = await waitForPlace(page, 'boston');
console.log(`screenshot ${shot1}`);
await verify('Boston', await readCard(page));

// 2. Back to the globe, then search "Lisbon" (EOT20, modelled).
await page.click('[data-back]');
await page.waitForTimeout(2500);
await page.screenshot({ path: join(outdir, `globe-${width}x${height}${webgl ? '-webgl' : ''}.png`) });
const isPhone = width < 768;
if (isPhone) await page.waitForSelector('[data-q]', { state: 'visible' });
await page.fill('[data-q]', 'Lisbon');
await page.waitForSelector('[data-results] li');
await page.keyboard.press('Enter');
const shot2 = await waitForPlace(page, 'lisbon');
console.log(`screenshot ${shot2}`);
await verify('Lisbon', await readCard(page));

// 3. Turn the crank: a day ahead, the card and the machine follow.
await page.evaluate(() => {
  const r = document.querySelector<HTMLInputElement>('[data-crank]')!;
  r.value = String(Number(r.value) + 24);
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1500);
await page.screenshot({ path: join(outdir, `lisbon-crank-${width}x${height}${webgl ? '-webgl' : ''}.png`) });
await verify('Lisbon, crank +24 h', await readCard(page));

await browser.close();
if (errors.length) failed = true;
console.log(`\n${failed ? 'FAILED' : 'PASSED'}${errors.length ? ` (${errors.length} page errors)` : ''}`);
process.exit(failed ? 1 : 0);
