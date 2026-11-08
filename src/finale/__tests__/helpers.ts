// Test helpers: a fetch that serves public/data from disk and NOAA's API from captured fixtures (offline).
import { readFileSync } from 'node:fs';
import type { FetchLike } from '../eot20.ts';

const PUBLIC = new URL('../../../public/', import.meta.url);
const FIXTURES = new URL('fixtures/', import.meta.url);

export const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(`data/${path}`, PUBLIC), 'utf8')) as T;

const fixture = (name: string) =>
  new Response(readFileSync(new URL(name, FIXTURES)), { headers: { 'content-type': 'application/json' } });

/** Serves '/data/…' from public/; NOAA metadata for San Francisco from fixtures; anything else: an outage. */
export function offlineFetch(opts: { noaaDown?: boolean } = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    if (url.startsWith('/data/')) {
      try {
        return new Response(readFileSync(new URL(url.slice(1), PUBLIC)));
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    if (opts.noaaDown) throw new TypeError('Failed to fetch');
    const m = url.match(/stations\/(\d{7})\/(harcon|datums)\.json/);
    if (m && m[1] === '9414290') return fixture(`9414290-${m[2]}.json`);
    return new Response(JSON.stringify({ error: { message: 'No data was found.' } }));
  };
  return Object.assign(f, { calls });
}
