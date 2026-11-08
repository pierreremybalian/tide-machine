# Tide Machine

Scroll-driven 3D explanation of how tides work and how Kelvin's tide-predicting machine (and the US "Old Brass Brains") predicted them, ending in a live "any coast on Earth" tool. Astro 7, vanilla TypeScript islands, three.js r186 WebGPU + TSL (WebGL2 fallback), nanostores, Lenis. Static output on Cloudflare Workers static assets at https://tide-machine.balian.dev (`pnpm run deploy`; plain `pnpm deploy` is a pnpm built-in). Infrastructure inherited from Block Universe (`../block-universe`). `HANDOFF.md` is the spec; `DECISIONS.md` logs deviations; `SCENES.md` is the scene authoring guide.

## Dev
- `pnpm dev` (port 4360). Scene harness: `/dev/scenes/?scene=<id>&local=0.5`.
- `pnpm test`, `pnpm check` and `pnpm lint` must pass before anything is done. `pnpm build` also writes `dist/_headers`.
- Data: `node scripts/fetch-noaa.ts` (stations, validation months, SF week/year, Sandy). NOAA data is public domain.
- Screenshots: `node scripts/shoot.ts --scene <id> --locals 0.1,0.5,0.9 --outdir scratch/shots` (`--webgl`, `--leak`); full page in a stage: `--stage <id> --at 0.3,0.7` (`--width 390 --height 844` for phones). Stills/OG: `pnpm stills`.

## Rules
- `src/tides/`, `src/coast/`, `src/time/`, `src/script/` are pure TypeScript (no DOM, no three). The tide predictor must keep matching NOAA (tests): never change a constituent convention without rerunning validation.
- Every water level on screen comes from `src/tides/predict.ts` with real constants; never hand-animate the tide. Vertical exaggeration, wave scale and time compression are uniforms and are stated in the stage note.
- Scenes are isolated (`src/scenes/<id>/`, auto-registered), share only `src/shared/`. Typed `params` at the top; dispose everything. No allocation in the frame loop.
- TSL: with `positionNode` set, use `attribute('position')` (not `positionLocal`) in fragment-side math; max 8 vertex buffers per pipeline.
- Text never goes in the canvas: `LabelSet` or HUD cards.
- Public repo hygiene: author `Pierre Balian <967646+pierreremybalian@users.noreply.github.com>`; Cloudflare account ID only in the gitignored `.env`.
