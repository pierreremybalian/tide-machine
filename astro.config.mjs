// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Dev-only routes (HANDOFF §15): the scene smoke test is not shipped.
/** @type {import('astro').AstroIntegration} */
const devRoutes = {
  name: 'dev-routes',
  hooks: {
    'astro:config:setup': ({ command, injectRoute }) => {
      if (command !== 'dev') return;
      injectRoute({ pattern: '/dev/scenes', entrypoint: './src/dev/scenes.astro' });
    },
  },
};

// Static output for Cloudflare Pages. No SSR adapter, no backend (HANDOFF §1).
export default defineConfig({
  site: 'https://tide-machine.balian.dev',
  output: 'static',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
  integrations: [devRoutes, mdx(), sitemap({ filter: (page) => !page.includes('/dev/') })],
  vite: {
    plugins: [tailwindcss()],
    // Pre-bundle three up front so the dev server does not re-optimise it mid-session.
    optimizeDeps: { include: ['three', 'three/webgpu', 'three/tsl', 'lenis', 'nanostores'] },
    worker: { format: 'es' },
    // Never inline assets as data: URIs, so the CSP can keep img-src strict.
    build: { assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
  },
});
