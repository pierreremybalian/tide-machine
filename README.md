# Tide Machine

How tides work, and how a brass machine learned to predict them. A scroll-driven 3D explanation built on real data: San Francisco Bay from real terrain and bathymetry, water driven by NOAA's harmonic constants, Kelvin's 1872 tide predictor and the US Coast Survey's 1912 "Old Brass Brains", and a finale that predicts the tide at any coast on Earth.

```
pnpm install
pnpm dev          # http://localhost:4360
pnpm test         # tide predictor vs NOAA, harmonic analysis, data schemas
pnpm build        # static site in dist/
```

- Spec: `HANDOFF.md`. Decisions: `DECISIONS.md`. Scene authoring: `SCENES.md`.
- Tide core: `src/tides/` (astronomical arguments, NOAA's 37 constituents with node corrections, prediction, harmonic analysis), tested against NOAA's official predictions at 25 ports.
- Data: NOAA CO-OPS (public domain); EOT20 global ocean tide model (Hart-Davis et al. 2021, CC BY 4.0); terrain and bathymetry from AWS Open Data terrain tiles.

Companion pieces: [Cosmic History](https://cosmic-history.balian.dev) and [Block Universe](https://block-universe.balian.dev). Deploy: `pnpm run deploy` (put `CLOUDFLARE_ACCOUNT_ID=<id>` in a gitignored `.env` first).
