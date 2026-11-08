# Decisions

Non-obvious choices, deviations from HANDOFF.md, and why.

## Stack
- **Inherited from Block Universe** (same lockfile, same pinned versions): render core, scroll driver, caption schedule, narration with status chips and dual clock, HUD card system, labels, panels, loupe, rig, build scripts. Dev port 4360.

## Tide prediction (validated against NOAA's official hourly predictions, January and July 2026, 25 ports)
- **Astronomy**: Meeus polynomials for s, h, p, N, p′ and obliquity; Schureman (SP-98) for I, ξ, ν, ν′, ν″, P; τ = T + h − s with T from the UT Julian day (ΔT ignored: < 0.001° in s).
- **Constituent conventions that differ from a literal reading of Schureman**, each chosen because it matches NOAA:
  - **S1**: V = T (not T + 180°). With +180° the diurnal residual at Philadelphia was 3.6 cm (twice S1's amplitude); with V = T, 0.2 cm.
  - **M1**: NOAA's M1 (14.4966939°/h) is the compound N2 − O1 (NO1) for u and f. Schureman's M1 node factors left a 1–2 cm diurnal residual; the compound brings the mean RMS from 1.02 to 0.72 cm.
  - **L2**: u = u(M2), f = Schureman's f(L2) (dropping his R term). Large-tide ports improve by half in January (Eastport 3.0 → 1.55 cm) at a small cost in July.
- **Result**: San Francisco 0.82 cm RMS (max 2.3), The Battery 0.39 cm (max 1.3); 21 of 24 other ports < 1 cm; worst Seattle 1.75 cm (Puget Sound's shallow-water constituents beyond the 37) and Eastport 1.55 cm (M2 is 2.6 m there).
- **Anchorage** replaced by **Juneau**: NOAA predicts Anchorage with 120 constituents; with the standard 37 our error was 23 cm RMS.
- **Harmonic analysis** fits one year of SF hourly data (Sa and Ssa excluded: a single year cannot separate them from weather) and recovers NOAA's M2, K1, O1, S2, N2 within 1.5 cm and 3°.

## Scope (owner, 2026-11-08)
- Added a 3D coastline throughline (SF Bay; 35 in-bay NOAA stations drive the water field) with physically motivated water, and an "any coast on Earth" finale: live terrain tiles (AWS Terrarium), live NOAA stations and gauges (CORS open), EOT20 (CC BY 4.0) where there is no gauge.
- **No photographic imagery**: commercial-friendly licences for global satellite tiles are not available for free; land is shaded from elevation.
