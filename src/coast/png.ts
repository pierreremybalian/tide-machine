// Minimal PNG decoder (pure; worker-safe). Parses chunks and reverses the scanline filters; the zlib inflate is
// injected so the same code runs in Node (node:zlib, build scripts and tests) and in the browser
// (DecompressionStream, finale tiles). Supports non-interlaced 8-bit grey, grey+alpha, RGB, RGBA and palette images,
// which covers the Terrarium terrain tiles.

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row-major from the top. */
  rgba: Uint8Array;
}

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/** Split a PNG into its header, palette and concatenated (still compressed) IDAT stream. */
export function parsePng(bytes: Uint8Array): { header: PngHeader; palette: Uint8Array | null; trns: Uint8Array | null; idat: Uint8Array } {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('not a PNG');
  let o = 8;
  let header: PngHeader | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const parts: Uint8Array[] = [];
  while (o + 8 <= bytes.length) {
    const len = u32(bytes, o);
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      header = { width: u32(data, 0), height: u32(data, 4), bitDepth: data[8]!, colorType: data[9]!, interlace: data[12]! };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!header) throw new Error('PNG without IHDR');
  let n = 0;
  for (const p of parts) n += p.length;
  const idat = new Uint8Array(n);
  n = 0;
  for (const p of parts) {
    idat.set(p, n);
    n += p.length;
  }
  return { header, palette, trns, idat };
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Reverse PNG scanline filters in place-free fashion: returns raw packed pixels (height × stride). */
export function unfilter(inflated: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const ft = inflated[src++]!;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const raw = inflated[src++]!;
      const a = x >= bpp ? out[row + x - bpp]! : 0;
      const b = y > 0 ? out[prev + x]! : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp]! : 0;
      let v: number;
      switch (ft) {
        case 0:
          v = raw;
          break;
        case 1:
          v = raw + a;
          break;
        case 2:
          v = raw + b;
          break;
        case 3:
          v = raw + ((a + b) >> 1);
          break;
        case 4:
          v = raw + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad PNG filter ${ft}`);
      }
      out[row + x] = v & 255;
    }
  }
  return out;
}

/** Decode a PNG to RGBA8. `inflate` decompresses a zlib stream (node:zlib inflateSync or equivalent). */
export function decodePng(bytes: Uint8Array, inflate: (z: Uint8Array) => Uint8Array): DecodedPng {
  const { header, palette, trns, idat } = parsePng(bytes);
  const { width, height, bitDepth, colorType, interlace } = header;
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} not supported`);
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`PNG colour type ${colorType} not supported`);
  const px = unfilter(inflate(idat), width, height, ch);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * ch;
    const d = i * 4;
    if (colorType === 2 || colorType === 6) {
      rgba[d] = px[s]!;
      rgba[d + 1] = px[s + 1]!;
      rgba[d + 2] = px[s + 2]!;
      rgba[d + 3] = colorType === 6 ? px[s + 3]! : 255;
    } else if (colorType === 3) {
      const k = px[s]!;
      if (!palette) throw new Error('palette PNG without PLTE');
      rgba[d] = palette[k * 3]!;
      rgba[d + 1] = palette[k * 3 + 1]!;
      rgba[d + 2] = palette[k * 3 + 2]!;
      rgba[d + 3] = trns && k < trns.length ? trns[k]! : 255;
    } else {
      const g = px[s]!;
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = colorType === 4 ? px[s + 1]! : 255;
    }
  }
  return { width, height, rgba };
}
