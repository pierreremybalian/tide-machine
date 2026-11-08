// The finale's HTML side (src/finale/ui/Finale.astro): search and suggestions, the pointer and keyboard layer over
// the globe and the coast, the place card (now, rising or falling, next high and low, the day's curve, the week with
// its crank, the machine's slot, the live gauge, the source note), the share link, and the narration hand-off
// (dual clock rows and the measured/modelled chip). Every number shown is predict() with the place's constants.

import { $stage } from '../../state/store.ts';
import { getDriver } from '../../scroll/driver.ts';
import { stageIndex, stageToProgress } from '../../time/stages.ts';
import { predict } from '../../tides/predict.ts';
import { TOOL_AT, setFinaleReadouts } from '../../script/anywhere.ts';
import { $statusOverride, refreshNarration } from '../../story/live.ts';
import { loadPlaces, parseLatLng, searchPlaces, type Place } from '../places.ts';
import { nextExtremes, rateAt } from '../extremes.ts';
import { backToGlobe, describePoint, placeFromUrl, selectPlace, formatLatLng } from './controller.ts';
import { $coastStatus, $coastView, $crankMs, $finale, $globe, $hover, $layout, $toolOn, WEEK_MS, bridge, type Rect, type Spot } from './state.ts';
import { SUGGESTED } from './suggested.ts';

const NS = 'http://www.w3.org/2000/svg';
const HOUR = 3600e3;

const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const fmtDayTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
const m2 = (m: number) => `${m < 0 ? '−' : '+'}${Math.abs(m).toFixed(2)} m`;
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const when = (t: number, ref: number) => (sameDay(t, ref) ? fmtTime.format(t) : fmtDayTime.format(t));

export function initFinale(root: HTMLElement): void {
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const layer = q<HTMLElement>('[data-layer]');
  const panelEl = q<HTMLElement>('[data-panel]');
  const input = q<HTMLInputElement>('[data-q]');
  const form = q<HTMLFormElement>('[data-form]');
  const results = q<HTMLUListElement>('[data-results]');
  const chips = q<HTMLElement>('[data-chips]');
  const status = q<HTMLElement>('[data-status]');
  const errorBox = q<HTMLElement>('[data-error]');
  const errorMsg = q<HTMLElement>('[data-error-msg]');
  const errorList = q<HTMLElement>('[data-error-list]');
  const card = q<HTMLElement>('[data-card]');
  const el = {
    name: q<HTMLElement>('[data-place-name]'),
    sub: q<HTMLElement>('[data-place-sub]'),
    chip: q<HTMLElement>('[data-src-chip]'),
    chipLabel: q<HTMLElement>('[data-src-label]'),
    when: q<HTMLElement>('[data-when]'),
    now: q<HTMLElement>('[data-now]'),
    trend: q<HTMLElement>('[data-trend]'),
    datum: q<HTMLElement>('[data-datum]'),
    high: q<HTMLElement>('[data-high]'),
    low: q<HTMLElement>('[data-low]'),
    day: q<SVGSVGElement>('[data-day]'),
    week: q<SVGSVGElement>('[data-week]'),
    crank: q<HTMLInputElement>('[data-crank]'),
    live: q<HTMLButtonElement>('[data-live]'),
    slot: q<HTMLElement>('[data-slot]'),
    slotCap: q<HTMLElement>('[data-slot-cap]'),
    observed: q<HTMLElement>('[data-observed]'),
    note: q<HTMLElement>('[data-note]'),
    terrain: q<HTMLElement>('[data-terrain]'),
    share: q<HTMLButtonElement>('[data-share]'),
    back: q<HTMLButtonElement>('[data-back]'),
    building: q<HTMLElement>('[data-building]'),
    sr: q<HTMLElement>('[data-sr]'),
    scroller: q<HTMLElement>('[data-scroller]'),
  };
  const docEl = document.documentElement;
  let places: Place[] = [];
  void loadPlaces()
    .then((p) => (places = p))
    .catch(() => {});

  // ── Suggested places ──
  for (const s of SUGGESTED) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = s.name;
    b.title = s.sub;
    b.addEventListener('click', () => choose({ lat: s.lat, lng: s.lng, name: s.name, sub: s.sub }));
    chips.appendChild(b);
  }

  function choose(req: { lat: number; lng: number; name: string; sub: string }) {
    docEl.classList.add('finale-engaged');
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    void selectPlace(req);
  }

  // ── Search: places by name, or typed coordinates ──
  let options: { label: string; sub: string; lat: number; lng: number }[] = [];
  let active = -1;
  const renderResults = () => {
    results.innerHTML = '';
    options.forEach((o, i) => {
      const li = document.createElement('li');
      li.id = `fin-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.innerHTML = `<b></b><span></span>`;
      li.querySelector('b')!.textContent = o.label;
      li.querySelector('span')!.textContent = o.sub;
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        choose({ lat: o.lat, lng: o.lng, name: o.label, sub: o.sub });
      });
      results.appendChild(li);
    });
    results.hidden = options.length === 0;
    input.setAttribute('aria-expanded', String(options.length > 0));
    input.setAttribute('aria-activedescendant', active >= 0 ? `fin-opt-${active}` : '');
  };
  input.addEventListener('input', () => {
    const v = input.value.trim();
    const ll = parseLatLng(v);
    options = ll ? [{ label: formatLatLng(ll.lat, ll.lng), sub: 'coordinates', lat: ll.lat, lng: ll.lng }] : [];
    const sug = SUGGESTED.filter((s) => v.length > 1 && s.name.toLowerCase().includes(v.toLowerCase())).map((s) => ({ label: s.name, sub: s.sub, lat: s.lat, lng: s.lng }));
    const found = searchPlaces(places, v, 7).map((p) => ({ label: p.name, sub: p.country, lat: p.lat, lng: p.lng }));
    for (const o of [...sug, ...found]) if (!options.some((x) => x.label === o.label && Math.abs(x.lat - o.lat) < 0.05)) options.push(o);
    options = options.slice(0, 7);
    active = options.length ? 0 : -1;
    renderResults();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      renderResults();
    } else if (e.key === 'Escape') {
      options = [];
      renderResults();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 150));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const o = options[Math.max(0, active)];
    if (o) {
      choose({ lat: o.lat, lng: o.lng, name: o.label, sub: o.sub });
      input.blur();
    } else if (input.value.trim()) {
      status.textContent = 'No coastal place by that name in our list. Try a nearby city, or type coordinates such as 38.70, -9.15.';
    }
  });

  // ── Pointer and keyboard over the 3D view ──
  let drag: { id: number; x: number; y: number; x0: number; y0: number; t0: number; moved: boolean } | null = null;
  const inCoast = () => $finale.get().phase === 'ready' && $coastStatus.get()?.status === 'ready';
  layer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener('pointermove', (e) => {
    const fx = e.clientX / innerWidth;
    const fy = e.clientY / innerHeight;
    if (!drag || drag.id !== e.pointerId) {
      if (e.pointerType === 'mouse' && $finale.get().phase !== 'ready') {
        const hit = bridge.pick?.(fx, fy) ?? null;
        $hover.set(hit);
        layer.style.cursor = hit ? 'crosshair' : 'grab';
      }
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) drag.moved = true;
    if (!drag.moved) return;
    docEl.classList.add('finale-engaged');
    $hover.set(null);
    if (inCoast()) {
      const c = $coastView.get();
      $coastView.set({ ...c, az: c.az - dx * 0.006, el: Math.max(-0.38, Math.min(0.8, c.el + dy * 0.004)) });
    } else if ($finale.get().phase !== 'locating' && $finale.get().phase !== 'ready') {
      const g = $globe.get();
      const k = (g.dist - 1) * 0.12;
      $globe.set({ ...g, lng: g.lng - dx * k, lat: Math.max(-75, Math.min(75, g.lat + dy * k)) });
    }
  });
  const end = (e: PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    const click = !drag.moved && performance.now() - drag.t0 < 600;
    drag = null;
    if (!click || inCoast()) return;
    const hit = bridge.pick?.(e.clientX / innerWidth, e.clientY / innerHeight);
    if (hit && $finale.get().phase !== 'locating') {
      docEl.classList.add('finale-engaged');
      void describePoint(hit.lat, hit.lng).then(choose);
    }
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', () => (drag = null));
  layer.addEventListener('pointerleave', () => $hover.set(null));
  layer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 15 : 5;
    const g = $globe.get();
    const coastMode = inCoast();
    let used = true;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const s = e.key === 'ArrowLeft' ? -1 : 1;
        if (coastMode) $coastView.set({ ...$coastView.get(), az: $coastView.get().az + s * 0.12 });
        else $globe.set({ ...g, lng: g.lng + s * step });
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const s = e.key === 'ArrowUp' ? 1 : -1;
        if (coastMode) {
          const c = $coastView.get();
          $coastView.set({ ...c, el: Math.max(-0.38, Math.min(0.8, c.el + s * 0.08)) });
        } else $globe.set({ ...g, lat: Math.max(-75, Math.min(75, g.lat + s * step)) });
        break;
      }
      case '+':
      case '=':
      case '-':
      case '_': {
        const s = e.key === '+' || e.key === '=' ? 1 / 1.2 : 1.2;
        if (coastMode) $coastView.set({ ...$coastView.get(), zoom: Math.max(0.4, Math.min(2.5, $coastView.get().zoom * s)) });
        else $globe.set({ ...g, dist: Math.max(1.6, Math.min(6, 1 + (g.dist - 1) * s)) });
        break;
      }
      case 'Enter':
        if (!coastMode && $finale.get().phase !== 'locating') void describePoint(g.lat, g.lng).then(choose);
        break;
      case 'Escape':
        if ($finale.get().phase !== 'globe') backToGlobe();
        break;
      default:
        used = false;
    }
    if (used) {
      e.preventDefault();
      docEl.classList.add('finale-engaged');
    }
  });
  layer.addEventListener('focus', () => {
    if ($finale.get().phase === 'globe') $hover.set({ lat: $globe.get().lat, lng: $globe.get().lng });
  });
  layer.addEventListener('blur', () => $hover.set(null));
  $globe.subscribe((g) => {
    if (document.activeElement === layer && $finale.get().phase === 'globe') $hover.set({ lat: g.lat, lng: g.lng });
  });

  el.back.addEventListener('click', () => {
    backToGlobe();
    input.value = '';
  });
  el.live.addEventListener('click', () => $crankMs.set(null));
  el.crank.addEventListener('input', () => {
    const s = $finale.get().spot;
    if (!s) return;
    $crankMs.set(s.weekT0 + Number(el.crank.value) * HOUR);
  });
  el.share.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      el.share.textContent = 'Link copied';
    } catch {
      el.share.textContent = 'Copy the address bar';
    }
    setTimeout(() => (el.share.textContent = 'Copy link'), 2200);
  });

  // ── Tool on/off with the stage ──
  let toolOn = false;
  const syncTool = () => {
    const s = $stage.get();
    const on = s.stageId === 'anywhere' && s.local >= TOOL_AT - 0.02;
    if (on === toolOn) return;
    toolOn = on;
    $toolOn.set(on);
    docEl.classList.toggle('finale-on', on);
    root.inert = !on;
    if (!on) $hover.set(null);
  };
  $stage.subscribe(() => requestAnimationFrame(syncTool));

  function fillStatic(spot: Spot) {
    const s = spot.source;
    // For scripts/finale-check.ts: what the numbers below were computed from.
    card.dataset.source = s.id;
    card.dataset.kind = s.kind;
    card.dataset.lat = String(spot.place.lat);
    card.dataset.lng = String(spot.place.lng);
    el.name.textContent = spot.place.name;
    el.sub.textContent = [spot.place.sub, /°/.test(spot.place.name) ? '' : formatLatLng(spot.place.lat, spot.place.lng)].filter(Boolean).join(' · ');
    const measured = s.kind === 'measured';
    el.chip.dataset.st = measured ? 'measured' : 'modelled';
    el.chipLabel.textContent = measured ? 'Measured' : 'Modeled';
    el.datum.textContent = s.datumLabel === 'MLLW' ? 'above mean lower low water' : 'relative to mean sea level';
    el.note.textContent = s.note;
    const t = spot.terrain;
    el.terrain.textContent = t
      ? `Terrain: ${t.tiles} AWS terrain tiles at zoom ${t.zoom}, 24 km across; relief and water ×${t.exaggeration}. Waves are a default wind sea. Times in your time zone${zone ? ` (${zone})` : ''}.`
      : `Times in your time zone${zone ? ` (${zone})` : ''}.`;
    el.slotCap.textContent = `Old Brass Brains, set for ${spot.place.name}: ${s.constants.length >= 30 ? 'all 37 cranks' : `${s.constants.length} of its 37 cranks`} turning; the pen draws the week below.`;
    el.crank.min = '0';
    el.crank.max = String(WEEK_MS / HOUR);
    el.crank.step = '0.25';
    drawWeek(spot);
    setFinaleStatus(spot);
    paintBuilding();
  }

  function setFinaleStatus(spot: Spot) {
    $statusOverride.set({ anywhere: spot.source.kind === 'measured' ? 'measured' : 'modelled' });
  }

  function fillObserved(spot: Spot) {
    const o = spot.observed;
    if (!o) {
      el.observed.textContent = spot.source.kind === 'measured' && spot.source.station?.live ? 'Live gauge: waiting for NOAA…' : '';
      return;
    }
    const pred = predict(spot.prepared, o.latest.t);
    const d = o.latest.v - pred;
    el.observed.textContent = `Live gauge: ${m2(o.latest.v)} at ${fmtTime.format(o.latest.t)} (NOAA, preliminary), ${Math.abs(d) < 0.005 ? 'right on the prediction' : `${Math.abs(d * 100).toFixed(0)} cm ${d > 0 ? 'above' : 'below'} the prediction: that is weather`}.`;
  }

  // ── Charts ──
  const svgEl = (tag: string, attrs: Record<string, string | number>) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const DAY = { w: 320, h: 84, top: 10, bottom: 16 };
  const WEEK = { w: 320, h: 46 };

  function drawWeek(spot: Spot) {
    const svg = el.week;
    svg.innerHTML = '';
    const { lo, hi } = spot.series.h.reduce((a, v) => ({ lo: Math.min(a.lo, v), hi: Math.max(a.hi, v) }), { lo: Infinity, hi: -Infinity });
    const X = (t: number) => ((t - spot.weekT0) / WEEK_MS) * WEEK.w;
    const Y = (h: number) => 4 + ((hi - h) / Math.max(0.01, hi - lo)) * (WEEK.h - 14);
    for (let d = 0; d <= 7; d++) {
      const t = spot.weekT0 + d * 86400e3;
      const day0 = new Date(t);
      day0.setHours(0, 0, 0, 0);
      const x = X(day0.getTime() + 86400e3);
      if (x > 0 && x < WEEK.w) svg.appendChild(svgEl('line', { x1: x, x2: x, y1: 0, y2: WEEK.h, class: 'tick' }));
      const lx = X(day0.getTime() + 86400e3 * 1.5);
      if (lx > 6 && lx < WEEK.w - 6) {
        const tx = svgEl('text', { x: lx, y: WEEK.h - 1, class: 'lab' });
        tx.textContent = fmtDay.format(day0.getTime() + 86400e3 * 1.5);
        svg.appendChild(tx);
      }
    }
    const s = spot.series;
    let d = '';
    for (let i = 0; i < s.h.length; i += 3) {
      const t = s.t0 + i * s.stepMs;
      if (t < spot.weekT0 || t > spot.weekT0 + WEEK_MS) continue;
      d += `${d ? 'L' : 'M'}${X(t).toFixed(1)},${Y(s.h[i]!).toFixed(1)}`;
    }
    svg.appendChild(svgEl('path', { d, class: 'curve' }));
    svg.appendChild(svgEl('line', { x1: 0, x2: 0, y1: 0, y2: WEEK.h - 10, class: 'nowline', 'data-wk-now': '' }));
    svg.appendChild(svgEl('line', { x1: 0, x2: 0, y1: 0, y2: WEEK.h - 10, class: 'crankline', 'data-wk-crank': '' }));
    svg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 3, class: 'head', 'data-wk-head': '' }));
    (svg as unknown as { _x: typeof X; _y: typeof Y })._x = X;
    (svg as unknown as { _x: typeof X; _y: typeof Y })._y = Y;
  }

  function drawDay(spot: Spot, ms: number) {
    const svg = el.day;
    svg.innerHTML = '';
    const t0 = ms - 6 * HOUR;
    const t1 = ms + 18 * HOUR;
    const n = 145;
    const hs = new Float64Array(n);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      hs[i] = predict(spot.prepared, t0 + ((t1 - t0) * i) / (n - 1));
      lo = Math.min(lo, hs[i]!);
      hi = Math.max(hi, hs[i]!);
    }
    const obs = spot.observed?.points.filter((p) => p.t >= t0 && p.t <= t1) ?? [];
    for (const p of obs) {
      lo = Math.min(lo, p.v);
      hi = Math.max(hi, p.v);
    }
    const pad = Math.max(0.05, (hi - lo) * 0.12);
    lo -= pad;
    hi += pad;
    const X = (t: number) => ((t - t0) / (t1 - t0)) * DAY.w;
    const Y = (h: number) => DAY.top + ((hi - h) / (hi - lo)) * (DAY.h - DAY.top - DAY.bottom);
    // Hour ticks every 6 h on the clock.
    const first = new Date(t0);
    first.setMinutes(0, 0, 0);
    for (let t = first.getTime(); t <= t1; t += HOUR) {
      const hr = new Date(t).getHours();
      if (hr % 6 !== 0 || t < t0) continue;
      const x = X(t);
      svg.appendChild(svgEl('line', { x1: x, x2: x, y1: DAY.top - 4, y2: DAY.h - DAY.bottom + 2, class: hr === 0 ? 'tick mid' : 'tick' }));
      const tx = svgEl('text', { x, y: DAY.h - 4, class: 'lab' });
      tx.textContent = hr === 0 ? fmtDay.format(t) : fmtTime.format(t).replace(':00', '');
      svg.appendChild(tx);
    }
    if (lo < 0 && hi > 0) svg.appendChild(svgEl('line', { x1: 0, x2: DAY.w, y1: Y(0), y2: Y(0), class: 'zero' }));
    let d = '';
    for (let i = 0; i < n; i++) d += `${i ? 'L' : 'M'}${X(t0 + ((t1 - t0) * i) / (n - 1)).toFixed(1)},${Y(hs[i]!).toFixed(1)}`;
    svg.appendChild(svgEl('path', { d: `${d}L${DAY.w},${DAY.h - DAY.bottom}L0,${DAY.h - DAY.bottom}Z`, class: 'fill' }));
    svg.appendChild(svgEl('path', { d, class: 'curve' }));
    for (const p of obs) svg.appendChild(svgEl('circle', { cx: X(p.t).toFixed(1), cy: Y(p.v).toFixed(1), r: 1.1, class: 'obs' }));
    for (const e of spot.series.extremes) {
      if (e.t < t0 || e.t > t1) continue;
      const x = X(e.t);
      const y = Y(e.h);
      svg.appendChild(svgEl('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.2, class: e.high ? 'hi' : 'lo' }));
      const tx = svgEl('text', { x: Math.min(DAY.w - 16, Math.max(16, x)), y: e.high ? y - 4 : y + 9, class: 'ext' });
      tx.textContent = fmtTime.format(e.t);
      svg.appendChild(tx);
    }
    const x = X(ms);
    svg.appendChild(svgEl('line', { x1: x, x2: x, y1: DAY.top - 6, y2: DAY.h - DAY.bottom, class: 'nowline' }));
    svg.appendChild(svgEl('circle', { cx: x, cy: Y(predict(spot.prepared, ms)), r: 3.2, class: 'head' }));
  }

  // ── The numbers, refreshed every few seconds (and on every crank move) ──
  let lastDayKey = '';
  function tick() {
    const f = $finale.get();
    const spot = f.phase === 'ready' ? f.spot : null;
    if (!spot) return;
    const now = Date.now();
    const cr = $crankMs.get();
    const ms = cr === null ? now : Math.min(spot.weekT0 + WEEK_MS, Math.max(spot.weekT0, cr));
    const live = cr === null;
    const h = predict(spot.prepared, ms);
    const rate = rateAt(spot.prepared, ms);
    const nx = nextExtremes(spot.series, ms);
    el.when.textContent = live ? `Now · ${fmtTime.format(ms)}` : `Machine time · ${fmtDayTime.format(ms)}`;
    el.live.hidden = live;
    el.now.textContent = m2(h);
    el.now.dataset.value = h.toFixed(4);
    el.now.dataset.ms = String(ms);
    el.trend.textContent = Math.abs(rate) < 0.01 ? 'turning' : `${rate > 0 ? '↑ rising' : '↓ falling'} ${Math.abs(rate * 100).toFixed(0)} cm/h`;
    el.high.textContent = nx.high ? `${when(nx.high.t, ms)} · ${m2(nx.high.h)}` : '—';
    el.low.textContent = nx.low ? `${when(nx.low.t, ms)} · ${m2(nx.low.h)}` : '—';
    el.high.dataset.t = String(nx.high?.t ?? '');
    el.high.dataset.value = nx.high ? nx.high.h.toFixed(4) : '';
    el.low.dataset.t = String(nx.low?.t ?? '');
    el.low.dataset.value = nx.low ? nx.low.h.toFixed(4) : '';
    if (document.activeElement !== el.crank) el.crank.value = String((ms - spot.weekT0) / HOUR);
    el.crank.setAttribute('aria-valuetext', `${fmtDayTime.format(ms)}: ${m2(h)}`);
    const dayKey = `${spot.key}|${Math.round(ms / 60e3)}|${spot.observed?.latest.t ?? 0}`;
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      drawDay(spot, ms);
    }
    const wk = el.week as unknown as { _x?: (t: number) => number; _y?: (h: number) => number };
    if (wk._x && wk._y) {
      const xn = wk._x(Math.min(spot.weekT0 + WEEK_MS, now)).toFixed(1);
      const xm = wk._x(ms).toFixed(1);
      const nl = el.week.querySelector('[data-wk-now]')!;
      nl.setAttribute('x1', xn);
      nl.setAttribute('x2', xn);
      const cl = el.week.querySelector('[data-wk-crank]')!;
      cl.setAttribute('x1', xm);
      cl.setAttribute('x2', xm);
      const hd = el.week.querySelector('[data-wk-head]')!;
      hd.setAttribute('cx', xm);
      hd.setAttribute('cy', wk._y(h).toFixed(1));
    }
    const datum = spot.source.datumLabel === 'MLLW' ? 'above MLLW' : 'vs mean sea level';
    setFinaleReadouts([
      { label: live ? 'Tide now' : 'Machine time', value: live ? `${m2(h)} ${rate >= 0 ? '↑' : '↓'}` : fmtDayTime.format(ms), tone: 'warm' },
      ...(live ? [] : [{ label: 'Pen', value: m2(h), tone: 'warm' as const }]),
      { label: 'Source', value: spot.source.kind === 'measured' ? `NOAA ${spot.source.id}` : 'EOT20 model', tone: 'b' },
    ]);
    refreshNarration();
    // Screen readers: one sentence, updated when the minute's numbers change.
    const sr = `${spot.place.name}: ${m2(h)} ${datum}, ${rate >= 0 ? 'rising' : 'falling'}. Next high ${nx.high ? `${when(nx.high.t, ms)}, ${m2(nx.high.h)}` : 'not within the week'}; next low ${nx.low ? `${when(nx.low.t, ms)}, ${m2(nx.low.h)}` : 'not within the week'}. ${spot.source.kind === 'measured' ? 'Measured: NOAA station constants.' : 'Modeled: EOT20.'}`;
    if (el.sr.textContent !== sr && (live ? true : document.activeElement !== el.crank)) el.sr.textContent = sr;
  }
  setInterval(tick, 5000);

  // ── Layout for the scene: the machine slot, its visible part, and the screen left free for the 3D view ──
  let lastLayout = '';
  const frac = (r: DOMRect): Rect => ({ x: r.left / innerWidth, y: r.top / innerHeight, w: r.width / innerWidth, h: r.height / innerHeight });
  const layout = () => {
    requestAnimationFrame(layout);
    const f = $finale.get();
    const showCard = toolOn && f.phase === 'ready' && !card.hidden;
    let slot: Rect | null = null;
    let clip: Rect | null = null;
    let free: Rect = { x: 0, y: 0, w: 1, h: 1 };
    // Desktop, globe: the search panel takes the left; centre the globe in the rest.
    if (toolOn && f.phase !== 'ready') {
      const pr = panelEl.getBoundingClientRect();
      if (innerWidth >= 768 && pr.right < innerWidth * 0.45) free = { x: pr.right / innerWidth, y: 0, w: 1 - pr.right / innerWidth, h: 1 };
      else if (innerWidth < 768) free = { x: 0, y: pr.bottom / innerHeight, w: 1, h: Math.max(0.3, 1 - pr.bottom / innerHeight - 0.08) };
    }
    if (showCard) {
      const cr = card.getBoundingClientRect();
      const sr = el.slot.getBoundingClientRect();
      const vr = el.scroller.getBoundingClientRect();
      slot = frac(sr);
      const x0 = Math.max(sr.left, vr.left, 0);
      const y0 = Math.max(sr.top, vr.top, 0);
      const x1 = Math.min(sr.right, vr.right, innerWidth);
      const y1 = Math.min(sr.bottom, vr.bottom, innerHeight);
      clip = x1 > x0 && y1 > y0 ? { x: x0 / innerWidth, y: y0 / innerHeight, w: (x1 - x0) / innerWidth, h: (y1 - y0) / innerHeight } : null;
      const opacity = Number(getComputedStyle(root).opacity || '1');
      if (opacity < 0.05) clip = null;
      // Desktop: the card on the right; phones: the sheet at the bottom.
      if (cr.left > innerWidth * 0.4) free = { x: 0, y: 0, w: Math.max(0.3, (cr.left - 12) / innerWidth), h: 1 };
      else free = { x: 0, y: 0, w: 1, h: Math.max(0.3, (cr.top + 8) / innerHeight) };
    }
    const key = JSON.stringify([slot, clip, free].map((r) => r && [r.x, r.y, r.w, r.h].map((v) => v.toFixed(4))));
    if (key !== lastLayout) {
      lastLayout = key;
      $layout.set({ slot, clip, free });
    }
  };
  requestAnimationFrame(layout);

  // ── State → DOM (wired last: the subscriptions fire at once) ──
  let shownKey = '';
  const onFinale = (f: ReturnType<typeof $finale.get>) => {
    docEl.classList.toggle('finale-place', f.phase === 'ready' || f.phase === 'locating');
    root.dataset.phase = f.phase;
    status.textContent = f.phase === 'locating' ? f.step : '';
    errorBox.hidden = f.phase !== 'error';
    if (f.error) {
      errorMsg.textContent = f.error.message;
      errorList.innerHTML = '';
      for (const p of f.error.suggestions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = p.name;
        b.title = p.country;
        b.addEventListener('click', () => choose({ lat: p.lat, lng: p.lng, name: p.name, sub: p.country }));
        errorList.appendChild(b);
      }
    }
    const spot = f.phase === 'ready' ? f.spot : null;
    card.hidden = !spot;
    if (!spot) {
      shownKey = '';
      setFinaleReadouts(null);
      $statusOverride.set({});
      refreshNarration();
      return;
    }
    if (spot.key !== shownKey) {
      shownKey = spot.key;
      fillStatic(spot);
      el.sr.textContent = '';
    }
    fillObserved(spot);
    tick();
  };
  const paintBuilding = () => {
    const f = $finale.get();
    const cs = $coastStatus.get();
    const spot = f.spot;
    el.building.textContent =
      !spot || f.phase !== 'ready'
        ? ''
        : spot.terrainError
          ? `The terrain could not load (${spot.terrainError}); the tide below is unaffected.`
          : cs?.key === spot.key && cs.status === 'ready'
            ? ''
            : cs?.key === spot.key && cs.status === 'failed'
              ? 'The 3D coast could not be built on this device; the tide below is unaffected.'
              : 'Building the coast…';
  };

  $finale.subscribe(onFinale);
  $coastStatus.subscribe(() => paintBuilding());
  $crankMs.subscribe(() => tick());

  // ── A shared link opens the place at the tool ──
  const fromUrl = placeFromUrl();
  if (fromUrl) {
    docEl.classList.add('finale-engaged');
    const go = () => {
      const d = getDriver();
      if (!d) return void setTimeout(go, 100);
      d.scrollToProgress(stageToProgress(stageIndex('anywhere'), 0.7), { immediate: true });
      void selectPlace(fromUrl);
    };
    go();
  }
}
