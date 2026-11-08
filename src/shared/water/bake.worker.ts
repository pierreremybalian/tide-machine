// Web Worker: runs src/coast/bake.ts off the main thread (tidal domain, AO, tide-field detours, wave eikonals).

import { bakeCoast, type BakeOptions } from '../../coast/bake.ts';
import type { Heightfield } from '../../coast/heightfield.ts';
import type { BayStation } from '../../coast/tidefield.ts';

interface Job {
  hf: Heightfield;
  stations: BayStation[];
  opts: BakeOptions;
}

self.onmessage = (e: MessageEvent<Job>) => {
  try {
    const bake = bakeCoast(e.data.hf, e.data.stations, e.data.opts);
    const transfer: Transferable[] = [bake.spill.buffer, bake.kind.buffer, bake.ao.buffer, bake.field.meanLevel.buffer, bake.wave.reach.buffer, bake.pondSdf.buffer, bake.dikedSdf.buffer];
    for (const a of [...bake.wave.T, ...bake.wave.amp, ...bake.detour.factors]) transfer.push(a.buffer);
    (self as unknown as Worker).postMessage({ ok: true, bake }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(err instanceof Error ? (err.stack ?? err.message) : err) });
  }
};
