// Runs after `astro build`. Writes dist/_headers for Cloudflare Pages: security headers, a Content-Security-Policy
// whose script hashes are computed from the built HTML (so it never goes stale), and caching for hashed assets.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const dist = new URL('../dist', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const hashes = new Set();
for (const f of walk(dist).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/ld\+json/.test(m[1])) continue; // data blocks are not executed
    hashes.add(`'sha256-${createHash('sha256').update(m[2]).digest('base64')}'`);
  }
}

const csp = [
  "default-src 'self'",
  // Cloudflare Web Analytics is injected at the edge on balian.dev (beacon script + reporting endpoint);
  // Google Analytics 4 per Google's CSP guidance (gtag.js, collection endpoints, pixel fallback).
  `script-src 'self' https://static.cloudflareinsights.com https://*.googletagmanager.com ${[...hashes].join(' ')}`,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.google-analytics.com https://*.googletagmanager.com https://s3.amazonaws.com",
  "font-src 'self'",
  // The finale reads NOAA's live tide API and AWS Open Data terrain tiles (both CORS-open).
  "connect-src 'self' https://cloudflareinsights.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://api.tidesandcurrents.noaa.gov https://s3.amazonaws.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const noindex = process.env.PUBLIC_NOINDEX === '1' ? '\n  X-Robots-Tag: noindex, nofollow' : '';
const headers = `/*${noindex}
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000

/dev/*
  X-Robots-Tag: noindex, nofollow

/_astro/*
  Cache-Control: public, max-age=31536000, immutable

/data/*
  Cache-Control: public, max-age=86400

/stills/*
  Cache-Control: public, max-age=86400
`;
writeFileSync(join(dist, '_headers'), headers);
console.log(`Wrote dist/_headers (${hashes.size} script hashes${noindex ? ', noindex preview' : ''}).`);
