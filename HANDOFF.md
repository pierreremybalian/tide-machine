# Tide Machine — Engineering Handoff

> **Read this whole file before writing code.** It is the source of truth for scope, architecture, contracts, data and build order. Infrastructure is inherited from Block Universe (`../block-universe`), which inherited it from Cosmic History (`../universe`). If something here conflicts with your instincts, follow this file and flag it; if something is ambiguous, pick the simplest option that keeps the contracts intact, log it in `DECISIONS.md`, and keep going.

---

## 1. What we're building

A guided, scroll-driven, full-screen 3D explanation of **how tides work and how a brass machine learned to predict them**, ending in a live tool: **pick any coast on Earth and see its tide, now.**

- **The model is the visual.** Every water level on screen is computed in the browser from harmonic constants (`src/tides/`), the same sum Kelvin's machine performs with pulleys and a wire. Our predictor matches NOAA's official predictions to < 1 cm RMS at San Francisco and The Battery (tested).
- **A real coastline carries the story.** San Francisco Bay, built from real terrain and bathymetry, with water driven by **35 NOAA harmonic stations inside the bay**, interpolated. The tide is seen arriving through the Golden Gate, growing in the South Bay and lagging into Suisun Bay. Mudflats drain and flood.
- **Water that looks and behaves like water.** A physically motivated water shader (§8.2): Fresnel sky reflection, depth-based absorption, wet/dry tidal flats, and wind waves whose speed, wavelength, height and direction respond to the bottom (shoaling, refraction, breaking).
- **The machine is the second protagonist.** Kelvin's 1872 machine explains the idea; the US Coast Survey's 1912 "Old Brass Brains" (37 constituents) runs. Procedural brass parts drawn as glowing outlines; one wire sums every pulley; the pen height *is* the bay's water level, side by side.
- **Honesty.** Every stage declares a status (§13) and names its exaggerations (vertical relief, wave height, bulge size, crank speed).

### Presentation (owner decisions)
Guided walkthrough with one caption at a time, status chip, dual clock and HUD cards (as Block Universe), then an **interactive finale** with pointer and keyboard controls. American spelling.

### Non-goals
No accounts, no backend (static site + public CORS APIs), no audio, no imagery that needs a commercial licence (terrain is shaded, not photographed).

---

## 2. Stack
Inherited: Astro 7 (static), TypeScript strict, three.js r186 `WebGPURenderer` + TSL (WebGL2 fallback), nanostores, Lenis, Vitest, ESLint/Prettier, pnpm, Tailwind v4 tokens, fontsource, Playwright (shots/stills), wrangler (Workers static assets, `tide-machine.balian.dev`). Python allowed only in `scripts/` for offline data prep (EOT20 netCDF). No new runtime dependency without a line in `DECISIONS.md`.

## 3. Architecture
Same spine as Block Universe: `$progress → (stage, local) → src/script/<stage>.ts → { scene, dual clock, HUD cards }`. Scenes are isolated (`src/scenes/<id>/`, auto-registered); scripts auto-register; HUD cards are `src/hud/cards/*.astro`. The finale stage additionally reads `$place` (the chosen location) and `$crank` (machine time) from its own UI panel.

```
src/
  tides/        astro, constituents (NOAA's 37), predict, analysis, equilibrium, machine (+ __tests__)   ← pure
  coast/        terrain tiles (decode, mesh), bathymetry, station interpolation, eikonal wave rays     ← pure (worker-safe)
  script/       one pure module per stage
  shared/gfx/   labels, ribbons, events, panels, loupe, rig, kit, palette (from Block Universe)
  shared/water/ water surface material, terrain material, wet/dry, wave field, foam
  shared/brass/ outline pass, gear/pulley/crank/frame geometry, machine assembly
  scenes/<id>/  stage scenes
  finale/       globe picker, place panel, data loaders (NOAA live, EOT20 tiles, terrain tiles)
public/data/    stations/, validation/, sf-week, sf-year, sandy, bay/ (SF, NYC terrain + station constants), eot20/ tiles
```

## 4. Tide core (`src/tides/`, done and tested)
- `astro.ts` mean elements (Meeus) and Schureman's I, ξ, ν, ν′, ν″, P.
- `constituents.ts` NOAA's 37 with extended Doodson numbers, node factors f and corrections u. Conventions verified against NOAA: S1 V = T; NOAA's M1 is the compound N2 − O1; L2 uses M2's u with Schureman's f (DECISIONS.md).
- `predict.ts` h(t) = Z₀ + Σ fH cos(V+u−κ).
- `analysis.ts` least-squares harmonic analysis (recovers NOAA's SF constants from one year of data).
- `equilibrium.ts` bulge heights (Moon 0.357 m, Sun 0.164 m).
- `machine.ts` (to build) Kelvin / Old Brass Brains: pulley layout, crank throw ∝ amplitude, crank angle = phase, gear trains (documented tooth counts where available, else best rational approximation within tooth limits, labelled), wire-sum identity, gear drift.

## 5. Contracts
`BlockScene` (from Block Universe) renamed `StageScene`; status values below. `registerStage(id, { note, readouts, dividers? })`. Spacetime/kit helpers stay available but the coast scenes use world units: x east, y up, z south, 1 unit = 1 km horizontally; vertical exaggeration is a uniform and always stated.

## 6. Data (`scripts/`, public-domain or CC BY)
| Data | Source | Use |
|---|---|---|
| Harmonic constants, datums, predictions, observations | NOAA CO-OPS API (public domain; CORS open) | everything US; validation; finale live overlay |
| SF Bay (35) and NY Harbor (30) station constants | NOAA CO-OPS | the bay's water field |
| Terrain + bathymetry | AWS Open Data terrain tiles (Terrarium PNG, CORS open; sources incl. NOAA CRM, ETOPO1, GEBCO, SRTM — attribution) | baked for SF and NYC at build; streamed live in the finale |
| Global ocean tides | EOT20 (Hart-Davis et al. 2021, CC BY 4.0, 17 constituents, 1/8°) | finale anywhere without a gauge; global amphidromes in stage 3 |
| Sandy 2012 | NOAA observed + predicted, The Battery | stage 12 |

`scripts/fetch-noaa.ts` (done), `scripts/fetch-coast.ts` (terrain + bay stations), `scripts/eot20_tiles.py` (netCDF → 5°×5° int16 amplitude/phase tiles for the 8 major constituents + M4, ocean cells only). zod schemas + drift tests.

## 7. Stages (13)
| # | id | Title | Status | Signature view |
|---|---|---|---|---|
| 1 | breathe | The sea breathes | measured | SF Bay in 3D; water follows a real week of the Fort Point gauge; flats appear at low water. |
| 2 | moon | The Moon pulls unevenly | simplified | Earth, Moon, the two equilibrium bulges (heights computed, drawn ×10⁶, stated); Earth turns under them. |
| 3 | wave | The bulge is a wave | measured | The ocean can't keep up: the tide travels as a wave. EOT20's M2 co-tidal lines wheel around amphidromic points; along the West Coast high water reaches San Diego, LA, SF, Newport, Seattle in order (station phases). |
| 4 | bay | Into the bay | measured | The wave enters the Golden Gate, slows in shallow water (c = √(gh)), grows in the South Bay and arrives late in Suisun; the water field is 35 stations interpolated; flats flood and drain. |
| 5 | sun | The Sun joins in | measured | M2 and S2 phasors; the bay's range swells and shrinks over 14.77 days (spring/neap) as the same two waves beat. |
| 6 | rhythms | Many rhythms | established | The constituent spectrum; each speed fixed by astronomy, each height measured at SF. |
| 7 | apart | Taking the tide apart | measured | A year of SF data unweaves into rotating phasors; our fit lands on NOAA's constants. |
| 8 | adds | A machine that adds | historical | Kelvin 1872 built piece by piece: crank throw = amplitude, angle = phase, gear = speed; one wire sums; the pen draws. 1 → 2 → 10 pulleys. |
| 9 | gears | Gears that keep astronomical time | measured | Each crank's gear train vs the true speed; the drift ladder over a year (computed). |
| 10 | brass | Old Brass Brains | historical | The 1912 US machine: 37 pulleys; a year of predictions in a day; in use into the 1960s; tide machines and D-Day. |
| 11 | crank | Turn the crank | measured | Machine and bay side by side: pen height = water at Fort Point; NOAA overlay; "machine vs NOAA: max N cm". |
| 12 | sandy | When the sea disagrees | measured | Lower Manhattan in 3D at Sandy's peak: the machine's tide vs the real water (surge = weather). |
| 13 | anywhere | Any coast on Earth | measured / modelled | Finale (§10). |

## 8. Rendering
### 8.1 Coast geometry
Terrain tiles (Terrarium: h = R·256 + G + B/256 − 32768 m) decoded to a heightfield; a clipmap-style mesh (dense near the focus, coarse far) with vertical exaggeration uniform; coastline = zero contour of (terrain − water level), recomputed on the GPU per frame (wet/dry). Land shading: slope + elevation ramp, soft hillshade, ambient occlusion from the heightfield, no imagery.
### 8.2 Water (`src/shared/water/`)
- **Level**: per-pixel water height from the tide field (bay: stations → IDW/Gaussian-weighted interpolation texture updated per frame; finale: single station or EOT20 point).
- **Depth** d = water − terrain drives: absorption (Beer–Lambert, separate RGB coefficients), turbidity, bottom visibility in the shallows, foam, and the waves.
- **Wind waves**: sum of directional Gerstner components (quality tier sets count) whose wavenumber satisfies the dispersion relation ω² = g k tanh(k d) per pixel; amplitude grows by Green's law / shoaling coefficient; **refraction**: wave phase from an eikonal solve (fast marching on the bathymetry grid, Web Worker) so crests bend parallel to the shore; **breaking** where H/d > 0.78 → foam + whitecap texture; swash on the wet/dry line.
- **Optics**: Fresnel (Schlick) sky reflection from a procedural sky (sun position from the stage's time and place), sun glitter (GGX), refraction offset of the bottom, subtle caustics in very shallow water, wet sheen on recently exposed flats.
- **Tide visibility**: current arrows/streaks optional; tide gauge pole at stations with a live marker.
- Performance: one water mesh, tier-scaled wave count and resolution; 60 fps medium.
### 8.3 Brass (`src/shared/brass/`)
Procedural parts (involute gears via extruded profiles, pulleys, Scotch-yoke cranks, frame, drum, wire, pen) rendered as dark solids with glowing brass outlines: a TSL port of Watch Academy's depth + normal edge pass (`../watch-academy/src/gfx/{Renderer,shaders}.ts`) using `pass()` + `mrt()`. Wire and pen trace as ribbons.
### 8.4 Space
Earth/Moon/Sun at schematic scale (stated), the bulge shell, the EOT20 co-tidal map on a globe.

## 9. Instruments
Phasor clock (stages 3, 5, 7); constituent spectrum (6); co-tidal sweep (3, 4); drift ladder (9); machine ↔ water sync (11, 13); surge gap (12); range breathing (5). HUD cards: constituent table, spectrum, machine-vs-NOAA, Sandy chart, place card (finale).

## 10. Finale: any coast on Earth
1. A globe (stylized land/sea, coast glow, EOT20 M2 tint). Click/tap or search a place; keyboard accessible.
2. Snap to the nearest ocean point; fetch terrain tiles for ~20 km around it; build coast + water.
3. **Tide source**, best first: NOAA harmonic station within 25 km (1,374 US stations; constants + datums from the NOAA API, live) → *measured*; else EOT20 at the point (bilinear in the 1/8° grid, nearest ocean cell) → *modelled*, with a note that global models are coarse inside bays and estuaries.
4. Water at **now** (predicted), rising/falling, next high and low, today's curve; the machine re-sets its crank throws and angles to those constants and draws the week; where NOAA has a live gauge, the observed level overlays.
5. Waves from a default wind sea (no live wind data), stated.
6. Shareable URL (`?lat=&lng=`).

## 11. Scroll & narration
Inherited (Lenis, `VH_PER_WEIGHT = 80`, caption schedule, keyboard stops, screen-reader text, hero, appendix with "How we know", sources, measured data list, positions list → here: the history of tide prediction).

## 12. Content
`src/content/stages/<id>.mdx`, same schema. Sources include Kelvin 1881 (ICE Proceedings), Schureman 1958 SP-98, Parker 2007 (NOAA "Tidal Analysis and Prediction"), NOAA history of "Old Brass Brains", Doodson and D-Day, Hart-Davis et al. 2021 (EOT20), NOAA Sandy report.

## 13. Status & honesty
measured (gauge data, NOAA constants, our NOAA-matched predictions) · established (accepted physics) · historical (documented history of the machines) · simplified (schematic models: bulges, interpolated fields) · modelled (global tide model where no gauge) · metaphor. Vertical exaggeration, wave scale and time compression always stated.

## 14. Quality gates
Tides tests (done) + coast tests (tile decode, interpolation reproduces station predictions at station points, eikonal monotonic) + data schemas; `pnpm check/lint/test/build`; shoot.ts per stage (desktop, 390×844, WebGL2, leak); fps probe; Playwright finale run (two places, crank, numbers vs `predict()`).

## 15. Build phases
1. Tide core + NOAA data + tests ✓. 2. Docs, skeleton, statuses, placeholder scenes. 3. Coast pipeline + water renderer (bay lab). 4. Brass renderer + machine (machine lab). 5. Anchor stages 4 (bay) and 11 (crank). 6. Parallel builders for the rest. 7. Finale (globe, live data, EOT20 tiles). 8. Polish, stills, OG/SEO, deploy when the owner says so.
