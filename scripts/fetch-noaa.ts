// Fetches NOAA CO-OPS data (US government, public domain) into public/data. Run once per data refresh:
//   node scripts/fetch-noaa.ts [--only 9414290,8518750] [--year 2026]
// Writes: stations/index.json, stations/<id>.json (harmonic constants + datums), validation/<id>-<month>.json
// (NOAA's official hourly predictions, for tests and the finale overlay), sf-week.json, sf-year.json, sandy.json.
import { writeFileSync } from 'node:fs';

const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const MD = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations';
const APP = 'tide-machine_explainer';
const out = (p: string) => new URL(`../public/data/${p}`, import.meta.url);
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Major US ports. Order is the finale's default order. */
export const PORTS: [id: string, label: string][] = [
  ['9414290', 'San Francisco, CA'],
  ['8518750', 'The Battery, New York, NY'],
  ['8443970', 'Boston, MA'],
  ['8410140', 'Eastport, ME'],
  ['8418150', 'Portland, ME'],
  ['8454000', 'Providence, RI'],
  ['8534720', 'Atlantic City, NJ'],
  ['8545240', 'Philadelphia, PA'],
  ['8574680', 'Baltimore, MD'],
  ['8638610', 'Sewells Point, Norfolk, VA'],
  ['8658120', 'Wilmington, NC'],
  ['8665530', 'Charleston, SC'],
  ['8670870', 'Fort Pulaski, Savannah, GA'],
  ['8720218', 'Mayport, Jacksonville, FL'],
  ['8723214', 'Virginia Key, Miami, FL'],
  ['8724580', 'Key West, FL'],
  ['8726520', 'St. Petersburg, FL'],
  ['8761724', 'Grand Isle, LA'],
  ['8771450', 'Galveston, TX'],
  ['9410170', 'San Diego, CA'],
  ['9410660', 'Los Angeles, CA'],
  ['9435380', 'South Beach, Newport, OR'],
  ['9447130', 'Seattle, WA'],
  ['9452210', 'Juneau, AK'],
  ['1612340', 'Honolulu, HI'],
];

// NOAA's JSON is untyped at this boundary; fields are read by name and validated by the data tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function json(url: string): Promise<Json> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
const get = (product: string, station: string, begin: string, end: string, extra = '') =>
  json(`${API}?product=${product}&station=${station}&begin_date=${begin}&end_date=${end}&datum=MLLW&time_zone=gmt&units=metric&format=json&application=${APP}${extra}`);

const only = opt('only')?.split(',');
const year = Number(opt('year') ?? new Date().getUTCFullYear());
const index: { id: string; label: string; name: string; state: string; lat: number; lng: number }[] = [];

for (const [id, label] of PORTS) {
  if (only && !only.includes(id)) continue;
  try {
    const meta = (await json(`${MD}/${id}.json`)).stations[0];
    const harcon = (await json(`${MD}/${id}/harcon.json?units=metric`)).HarmonicConstituents as Json[];
    const datums = (await json(`${MD}/${id}/datums.json?units=metric`)).datums as { name: string; value: number }[];
    const d = Object.fromEntries(datums.map((x) => [x.name, x.value]));
    if (!harcon?.length || d.MSL === undefined || d.MLLW === undefined) throw new Error('missing harcon or datums');
    const station = {
      id,
      label,
      name: meta.name as string,
      state: meta.state as string,
      lat: meta.lat as number,
      lng: meta.lng as number,
      /** Mean sea level above mean lower low water, m (the constant term when predicting relative to MLLW). */
      z0: Math.round((d.MSL - d.MLLW) * 1000) / 1000,
      datums: { MHHW: d.MHHW, MHW: d.MHW, MSL: d.MSL, MLW: d.MLW, MLLW: d.MLLW },
      constituents: harcon
        .filter((c) => c.amplitude > 0)
        .map((c) => ({ name: c.name as string, amplitude: c.amplitude as number, phase: c.phase_GMT as number, speed: c.speed as number })),
    };
    writeFileSync(out(`stations/${id}.json`), JSON.stringify(station, null, 1));
    index.push({ id, label, name: station.name, state: station.state, lat: station.lat, lng: station.lng });
    // NOAA's official hourly predictions for two validation months (tests + the finale's overlay).
    for (const m of [0, 6]) {
      const b = new Date(Date.UTC(year, m, 1));
      const e = new Date(Date.UTC(year, m + 1, 0, 23));
      const pr = await get('predictions', id, ymd(b), ymd(e), '&interval=h');
      const vals = (pr.predictions as { t: string; v: string }[]).map((p) => Math.round(Number(p.v) * 1000));
      writeFileSync(
        out(`validation/${id}-${year}-${String(m + 1).padStart(2, '0')}.json`),
        JSON.stringify({ station: id, start: `${b.toISOString().slice(0, 13)}:00Z`, stepMinutes: 60, unit: 'mm', datum: 'MLLW', values: vals }),
      );
    }
    console.log(`${id} ${label}: ${station.constituents.length} constituents, z0 ${station.z0} m`);
  } catch (err) {
    console.warn(`skip ${id} ${label}: ${(err as Error).message}`);
  }
}
if (!only) writeFileSync(out('stations/index.json'), JSON.stringify(index, null, 1));

// San Francisco: a week of 6-minute observations (stage 1) and a year of hourly observations (stage 5).
if (!only || only.includes('sf')) {
  const wk = await get('water_level', '9414290', `${year - 1}0601`, `${year - 1}0607`);
  writeFileSync(
    out('sf-week.json'),
    JSON.stringify({ station: '9414290', start: `${year - 1}-06-01T00:00Z`, stepMinutes: 6, unit: 'mm', datum: 'MLLW', values: wk.data.map((r: Json) => (r.v === '' ? null : Math.round(Number(r.v) * 1000))) }),
  );
  const yr: (number | null)[] = [];
  for (let m = 0; m < 12; m++) {
    const b = new Date(Date.UTC(year - 1, m, 1));
    const e = new Date(Date.UTC(year - 1, m + 1, 0));
    const r = await get('hourly_height', '9414290', ymd(b), ymd(e));
    for (const row of r.data) yr.push(row.v === '' ? null : Math.round(Number(row.v) * 1000));
  }
  writeFileSync(out('sf-year.json'), JSON.stringify({ station: '9414290', start: `${year - 1}-01-01T00:00Z`, stepMinutes: 60, unit: 'mm', datum: 'MLLW', values: yr }));
  console.log(`sf-week: ${wk.data.length} samples; sf-year: ${yr.length} hours`);
}

// Hurricane Sandy at The Battery: observed vs predicted, 6-minute, 27–31 October 2012.
if (!only || only.includes('sandy')) {
  const obs = await get('water_level', '8518750', '20121027', '20121031');
  const pre = await get('predictions', '8518750', '20121027', '20121031', '&interval=6');
  writeFileSync(
    out('sandy.json'),
    JSON.stringify({
      station: '8518750',
      start: '2012-10-27T00:00Z',
      stepMinutes: 6,
      unit: 'mm',
      datum: 'MLLW',
      observed: obs.data.map((r: Json) => (r.v === '' ? null : Math.round(Number(r.v) * 1000))),
      predicted: pre.predictions.map((r: Json) => Math.round(Number(r.v) * 1000)),
    }),
  );
  console.log(`sandy: ${obs.data.length} observed, ${pre.predictions.length} predicted`);
}
