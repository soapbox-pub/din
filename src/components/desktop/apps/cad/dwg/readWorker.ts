/// <reference lib="webworker" />
/**
 * Reads a DWG with LibreDWG (GPL-3.0, compiled to WebAssembly by
 * @mlightcad/libredwg-web), off the main thread. A drawing is untrusted
 * input to a C parser, so it gets a worker of its own: whatever the file
 * does to LibreDWG's memory stays here, and the worker is thrown away after
 * one file.
 */
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';

self.onmessage = async (e: MessageEvent<{ bytes: ArrayBuffer }>) => {
  try {
    const lib = await LibreDwg.create();
    const dwg = lib.dwg_read_data(e.data.bytes, Dwg_File_Type.DWG);
    if (!dwg) throw new Error('LibreDWG couldn’t read it.');
    const db = lib.convert(dwg);
    lib.dwg_free(dwg);
    // Thumbnails and extended data aren't used, and can be big.
    delete db.thumbnailImage;
    self.postMessage({ ok: true, db });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
