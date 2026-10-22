// Builds the ad blocker's filter engine (electron/adblock.mts), as an
// Electron utility process: downloading the lists and parsing their tens of
// thousands of rules takes seconds of CPU, which would stall input routing
// in the main process.
//
// Writes the serialized engine to the path given as the first argument and
// exits, with status 0 once it's there; the main process reads it from there.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import { FiltersEngine, adsAndTrackingLists } from '@ghostery/adblocker';

const out = process.argv[2];

try {
  const engine = await FiltersEngine.fromLists(fetch, adsAndTrackingLists, {
    enableMutationObserver: true,
    loadCosmeticFilters: true,
    loadNetworkFilters: true,
  });
  const partial = `${out}.partial`;
  fs.writeFileSync(partial, engine.serialize());
  fs.renameSync(partial, out);
  process.exit(0);
} catch (error) {
  console.error('adblock: building the filter engine failed:', error);
  process.exit(1);
}
