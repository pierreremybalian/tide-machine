"""EOT20 ocean tides → compact tiles for the finale (HANDOFF §6, §10).

    python3 -m venv scripts/.venv && scripts/.venv/bin/pip install -r scripts/requirements.txt
    scripts/.venv/bin/python -I scripts/eot20_tiles.py [--zip scripts/cache/eot20/EOT20.zip]

Source: EOT20, Hart-Davis, Piccioni, Dettmering, Schwatke, Passaro, Seitz (2021), DGFI-TUM. SEANOE,
https://doi.org/10.17882/79489; paper https://doi.org/10.5194/essd-13-3869-2021. Licence CC BY 4.0.
The 2.3 GB zip is downloaded once to scripts/cache/eot20/ (gitignored); only the ocean-tide netCDFs of the nine
constituents below are read from it.

Output (public/data/eot20/):
  index.json     constituents, scales, grid, tile list, credit
  <tile>.bin     10°×10° tiles named by their south-west corner (n30w130 …): 81×81 nodes (80×80 cells) at
                 EOT20's native 1/8°, both edges included; every ocean node within 1° (8 nodes) of land, and only
                 the 1/4° lattice farther out, where the tide varies over hundreds of km (the error this costs
                 is printed); all-land tiles skipped
  overview.bin   the whole globe at 1/2° (M2, S2, K1, O1) for globe tints and co-tidal maps
Binary layout: src/finale/eot20.ts (decodeTile). Amplitude int16 mm, Greenwich phase lag uint16 0.01°,
stored nodes only, behind a bit mask.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from netCDF4 import Dataset

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'scripts' / 'cache' / 'eot20'
OUT = ROOT / 'public' / 'data' / 'eot20'
URL = 'https://www.seanoe.org/data/00683/79489/data/85762.zip'

CONSTITUENTS = ['M2', 'S2', 'N2', 'K2', 'K1', 'O1', 'P1', 'Q1', 'M4']
OVERVIEW = ['M2', 'S2', 'K1', 'O1']
TILE = 10  # degrees
N8 = 8  # nodes per degree at the native 1/8°
FINE_MARGIN = 8  # nodes (1°): ocean nodes this close to land are all kept; farther out only the 1/4° lattice
THIN_TOL_CM = 0.5  # … plus, with their neighbours, nodes the 1/4° lattice would miss by more than this
MAGIC = b'EOTT'
VERSION = 1


def download(zip_path: Path) -> None:
    if zip_path.exists():
        return
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    print(f'downloading {URL} (~2.3 GB) → {zip_path}')
    tmp = zip_path.with_suffix('.part')
    with urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'tide-machine data prep'})) as r, open(tmp, 'wb') as f:
        while chunk := r.read(1 << 22):
            f.write(chunk)
    tmp.rename(zip_path)


def open_ocean_tides(zip_path: Path) -> zipfile.ZipFile:
    """The SEANOE zip holds two zips (load_tides.zip, ocean_tides.zip); the inner ocean one is extracted once."""
    outer = zipfile.ZipFile(zip_path)
    inner = [n for n in outer.namelist() if n.lower().endswith('ocean_tides.zip')]
    if not inner:
        return outer
    path = zip_path.parent / 'ocean_tides.zip'
    if not path.exists():
        print(f'extracting {inner[0]} → {path}')
        tmp = path.with_suffix('.part')
        with outer.open(inner[0]) as src, open(tmp, 'wb') as dst:
            while chunk := src.read(1 << 22):
                dst.write(chunk)
        tmp.rename(path)
    outer.close()
    return zipfile.ZipFile(path)


def member_for(names: list[str], k: str) -> str:
    """The ocean-tide netCDF of constituent k inside the zip (not the load tide)."""
    pat = re.compile(rf'(^|/){k}_ocean_eot20\.nc$', re.I)
    hits = [n for n in names if pat.search(n) and 'load' not in n.lower()]
    if len(hits) != 1:
        raise SystemExit(f'{k}: expected one ocean-tide file in the zip, found {hits}')
    return hits[0]


def read_constituent(z: zipfile.ZipFile, member: str, k: str):
    """→ lat (ascending), lon (0..360), amplitude (m), phase (degrees), with NaN on land."""
    raw = z.read(member)
    with Dataset(f'{k}.nc', mode='r', memory=raw) as ds:
        ds.set_auto_mask(False)  # EOT20's _FillValue is 0.0: land is amplitude 0, handled below
        lat = np.asarray(ds.variables['lat'][:], dtype=np.float64)
        lon = np.asarray(ds.variables['lon'][:], dtype=np.float64)
        va, vp = ds.variables['amplitude'], ds.variables['phase']
        units_a = getattr(va, 'units', '?')
        units_p = getattr(vp, 'units', '?')
        amp = np.asarray(va[:], dtype=np.float64)
        pha = np.asarray(vp[:], dtype=np.float64)
        re_ = np.asarray(ds.variables['real'][:], dtype=np.float64) if 'real' in ds.variables else None
        im_ = np.asarray(ds.variables['imag'][:], dtype=np.float64) if 'imag' in ds.variables else None
        dims = va.dimensions
    land = ~np.isfinite(amp) | (amp <= 0) | ~np.isfinite(pha)
    amp[land] = np.nan
    pha[land] = np.nan
    if dims[0].startswith('lon'):  # stored (lon, lat): make it (lat, lon)
        amp, pha = amp.T, pha.T
        re_ = None if re_ is None else re_.T
        im_ = None if im_ is None else im_.T
    if units_a.lower() not in ('cm', 'centimeters', 'centimetres'):
        raise SystemExit(f'{k}: amplitude units {units_a!r}, expected cm')
    if 'deg' not in units_p.lower():
        raise SystemExit(f'{k}: phase units {units_p!r}, expected degrees')
    # Convention check: real + i·imag must equal A·e^{iφ} (or its conjugate); report which.
    if re_ is not None and im_ is not None:
        ok = np.isfinite(amp) & (amp > 1)
        z_ri = re_[ok] + 1j * im_[ok]
        z_ap = amp[ok] * np.exp(1j * np.radians(pha[ok]))
        same = np.median(np.abs(z_ri - z_ap))
        conj = np.median(np.abs(z_ri - np.conj(z_ap)))
        print(f'  {k}: amplitude [{units_a}], phase [{units_p}]; |re+i·im − A·e^(iφ)| median {same:.3g}, conj {conj:.3g}')
    if lat[0] > lat[-1]:
        lat, amp, pha = lat[::-1], amp[::-1], pha[::-1]
    return lat, lon, amp / 100.0, pha  # cm → m


def to_global(lat: np.ndarray, lon: np.ndarray, a: np.ndarray) -> np.ndarray:
    """Resample (exactly, by index) onto nodes lat −90..90, lng −180..180 at 1/8°: shape (1441, 2881)."""
    if not (np.allclose(np.diff(lat), 1 / N8) and np.allclose(np.diff(lon), 1 / N8)):
        raise SystemExit('EOT20 grid is not the expected regular 1/8° grid')
    rows, cols = 180 * N8 + 1, 360 * N8 + 1
    out = np.full((rows, cols), np.nan)
    li = np.rint((lat + 90) * N8).astype(int)
    gl = np.arange(cols) / N8 - 180  # target longitudes
    src = np.rint((np.mod(gl, 360) - lon[0]) * N8).astype(int)
    if src.min() < 0 or src.max() >= len(lon):
        raise SystemExit('EOT20 longitudes do not cover 0..360')
    out[li[:, None], np.arange(cols)[None, :]] = a[:, src]
    return out


def encode(lat0: float, lng0: float, step8: int, names: list[str], amp: np.ndarray, pha: np.ndarray,
           thin: int = 0, margin: int = 0) -> bytes:
    """amp, pha: (k, rows, cols) in m and degrees, NaN amplitude where not stored. Same bytes as encodeTile()."""
    _, rows, cols = amp.shape
    ocean = np.isfinite(amp).all(axis=0).ravel()
    count = int(ocean.sum())
    head = struct.pack('<4sBBHhhHHIBBH', MAGIC, VERSION, len(names), step8, round(lat0 * N8), round(lng0 * N8),
                       rows, cols, count, thin, margin, 0)
    head += b''.join(n.encode('ascii')[:4].ljust(4, b'\0') for n in names)
    mask = np.packbits(ocean.astype(np.uint8), bitorder='little').tobytes()
    mask += b'\0' * (-len(mask) % 4)
    body = []
    for k in range(len(names)):
        a = np.clip(np.rint(amp[k].ravel()[ocean] * 1000), 0, 32767).astype('<i2')
        p = (np.rint(np.mod(pha[k].ravel()[ocean], 360) * 100) % 36000).astype('<u2')
        body += [a.tobytes(), p.tobytes()]
    return head + mask + b''.join(body)


def tile_name(lat0: int, lng0: int) -> str:
    return f"{'s' if lat0 < 0 else 'n'}{abs(lat0):02d}{'w' if lng0 < 0 else 'e'}{abs(lng0):03d}"


def dilate(land: np.ndarray, n: int) -> np.ndarray:
    """Box dilation by n nodes (longitude wraps)."""
    out = land.copy()
    for d in range(1, n + 1):
        out |= np.roll(land, d, axis=1) | np.roll(land, -d, axis=1)
    rows = out.copy()
    for d in range(1, n + 1):
        rows[d:] |= out[:-d]
        rows[:-d] |= out[d:]
    return rows


def coarse_error(A: np.ndarray, P: np.ndarray) -> np.ndarray:
    """Per node: the largest |Δ(H·e^iκ)| (cm) over all constituents if the node were bilinearly interpolated
    from the even (1/4°) lattice instead of stored (0 on the lattice, NaN next to land)."""
    err = np.zeros(A.shape[1:])
    for k in range(A.shape[0]):
        Z = A[k] * np.exp(1j * np.radians(P[k]))
        Zc = Z.copy()
        Zc[::2, 1::2] = (Z[::2, :-1:2] + Z[::2, 2::2]) / 2
        Zc[1::2, ::2] = (Z[:-1:2, ::2] + Z[2::2, ::2]) / 2
        Zc[1::2, 1::2] = (Z[:-1:2, :-1:2] + Z[:-1:2, 2::2] + Z[2::2, :-1:2] + Z[2::2, 2::2]) / 4
        err = np.fmax(err, np.abs(Z - Zc) * 100)
    return err


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', type=Path, default=CACHE / 'EOT20.zip')
    args = ap.parse_args()
    download(args.zip)

    amp = {}
    pha = {}
    with open_ocean_tides(args.zip) as z:
        names = z.namelist()
        for k in CONSTITUENTS:
            lat, lon, a, p = read_constituent(z, member_for(names, k), k)
            amp[k], pha[k] = to_global(lat, lon, a), to_global(lat, lon, p)
    A = np.stack([amp[k] for k in CONSTITUENTS])
    P = np.stack([pha[k] for k in CONSTITUENTS])
    ocean = np.isfinite(A).all(axis=0) & np.isfinite(P).all(axis=0)
    A[:, ~ocean] = np.nan
    print(f'grid {ocean.shape}, ocean nodes {ocean.sum()} ({ocean.mean():.1%}); '
          f'max M2 {np.nanmax(amp["M2"]):.2f} m')
    # Thinning: keep every ocean node within FINE_MARGIN of land, only the even (1/4°) lattice farther out,
    # except where the tide changes too fast for it (reefs, passes, the EOT20/FES2014 seam at 66°): there the
    # nodes and their neighbours stay. Tiles start at multiples of 10° = 80 nodes, so the global even lattice is
    # each tile's even lattice.
    even = np.zeros_like(ocean)
    even[::2, ::2] = True
    err = coarse_error(A, P)
    steep = dilate(np.nan_to_num(err) > THIN_TOL_CM, 2)
    keep = ocean & (dilate(~ocean, FINE_MARGIN) | even | steep)
    e = err[ocean & ~keep]
    print(f'thinned {e.size} nodes; 1/4° interpolation error there (worst constituent, cm): '
          f'RMS {np.sqrt(np.mean(e ** 2)):.3f}, 99.9% {np.percentile(e, 99.9):.2f}, max {e.max():.2f}')
    At = A.copy()
    At[:, ~keep] = np.nan

    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob('*.bin'):
        f.unlink()
    tiles: list[str] = []
    size = 0
    for lat0 in range(-90, 90, TILE):
        for lng0 in range(-180, 180, TILE):
            r0, c0 = (lat0 + 90) * N8, (lng0 + 180) * N8
            sl = (slice(None), slice(r0, r0 + TILE * N8 + 1), slice(c0, c0 + TILE * N8 + 1))
            if not ocean[sl[1:]].any():
                continue  # all land
            b = encode(lat0, lng0, 1, CONSTITUENTS, At[sl], P[sl], thin=2, margin=FINE_MARGIN)
            name = tile_name(lat0, lng0)
            (OUT / f'{name}.bin').write_bytes(b)
            tiles.append(name)
            size += len(b)
    print(f'kept {keep.sum()} of {ocean.sum()} ocean nodes ({keep.sum() / ocean.sum():.1%})')

    o = (slice(None), slice(None, None, 4), slice(None, None, 4))
    ki = [CONSTITUENTS.index(k) for k in OVERVIEW]
    ov = encode(-90, -180, 4, OVERVIEW, A[o][ki], P[o][ki])
    (OUT / 'overview.bin').write_bytes(ov)

    index = {
        'format': 'tide-machine EOT20 tiles v1 (src/finale/eot20.ts)',
        'source': 'EOT20 global empirical ocean tide model, ocean tide (not load tide)',
        'doi': 'https://doi.org/10.17882/79489',
        'paper': 'https://doi.org/10.5194/essd-13-3869-2021',
        'licence': 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)',
        'credit': 'Hart-Davis, M. G., Piccioni, G., Dettmering, D., Schwatke, C., Passaro, M., Seitz, F. (2021). '
                  'EOT20: a global ocean tide model from multi-mission satellite altimetry. Earth Syst. Sci. Data 13, '
                  '3869–3884. DGFI-TUM.',
        'changes': 'Nine constituents; amplitude rounded to 1 mm and phase to 0.01°; split into 10° tiles; ocean more '
                   'than 1° from land subsampled to 1/4° where that changes no constant by more than 0.5 cm; '
                   'a 1/2° global overview subsampled from the 1/8° grid.',
        'constituents': CONSTITUENTS,
        'phaseConvention': 'Greenwich phase lag κ in degrees: h = Σ f·H·cos(V + u − κ), as NOAA and src/tides/predict.ts',
        'datum': 'Mean sea level (the model has no chart datum)',
        'scale': {'amplitude': 0.001, 'phase': 0.01},
        'grid': {'tileDeg': TILE, 'baseStep': 1 / N8, 'nodes': TILE * N8 + 1, 'fullResolutionWithinDeg': FINE_MARGIN / N8},
        'tiles': sorted(tiles),
        'overview': {'file': 'overview.bin', 'step': 4 / N8, 'constituents': OVERVIEW},
    }
    (OUT / 'index.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')) + '\n')
    total = size + len(ov) + (OUT / 'index.json').stat().st_size
    print(f'{len(tiles)} tiles {size / 1e6:.1f} MB; overview {len(ov) / 1e6:.2f} MB; total {total / 1e6:.1f} MB')


if __name__ == '__main__':
    sys.exit(main())
