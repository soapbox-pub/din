// Builds the ad blocker's filter engine (electron/adblock.mts), as an
// Electron utility process: downloading the lists and parsing their tens of
// thousands of rules takes seconds of CPU, which would stall input routing
// in the main process.
//
// The lists come from Ghostery's CDN, which is what Ghostery's own extension
// reads: uBlock Origin's and EasyList's lists, mirrored within hours of
// upstream and with scriptlet arguments already normalized for this engine,
// plus the scriptlet code that goes with them. (@ghostery/adblocker's
// `adsAndTrackingLists` point at a copy in its GitHub repo instead, which is
// refreshed by hand and was two months behind - long enough for YouTube to
// get past every one of its rules.)
//
// Writes the serialized engine to the path given as the first argument, and
// the list revisions it was built from beside it. Exits 0 once a new engine
// is there, 2 if the lists haven't changed since the last build (the engine's
// mtime is bumped so it counts as fresh), 1 on failure. The main process
// reads the engine from there.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import { FiltersEngine } from '@ghostery/adblocker';

const CDN = 'https://cdn.ghostery.com/adblocker/resources';

/** uBlock Origin's default lists, as Ghostery names them. */
const LISTS = [
  'ublock-filters',
  'ublock-filters-2020',
  'ublock-filters-2021',
  'ublock-filters-2022',
  'ublock-filters-2023',
  'ublock-filters-2024',
  'ublock-filters-2025',
  'ublock-filters-2026',
  'ublock-badware',
  'ublock-privacy',
  'ublock-abuse',
  'ublock-unbreak',
  'ublock-quick-fixes',
  'easylist',
  'easyprivacy',
  'plowe-0',
];
const RESOURCES = 'ublock-resources-json';

const out = process.argv[2];
const revisionsFile = `${out}.revisions`;

async function fetchOk(url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      throw new Error(`${url}: HTTP ${response.status}`);
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** The latest revision of a list, or null if the CDN doesn't have it. */
async function latestRevision(name: string): Promise<string | null> {
  try {
    const { revisions } = (await (await fetchOk(`${CDN}/${name}/metadata.json`)).json()) as { revisions?: unknown };
    const latest = Array.isArray(revisions) ? revisions.at(-1) : undefined;
    return typeof latest === 'string' && /^[0-9a-f]+$/.test(latest) ? latest : null;
  } catch (error) {
    // A list that's gone (a year's list retired, say) isn't worth failing
    // over; the core ones are checked below.
    console.error(`adblock: no revision for ${name}:`, error);
    return null;
  }
}

async function download(name: string, revision: string): Promise<string> {
  return (await fetchOk(`${CDN}/${name}/${revision}/list.txt`)).text();
}

try {
  const names = [...LISTS, RESOURCES];
  const revisions = Object.fromEntries(
    (await Promise.all(names.map(async (name) => [name, await latestRevision(name)] as const))).filter(
      (entry): entry is readonly [string, string] => entry[1] !== null,
    ),
  );
  for (const name of [RESOURCES, 'ublock-filters', 'ublock-quick-fixes', 'easylist']) {
    if (!revisions[name]) throw new Error(`${name} is unavailable`);
  }

  const key = JSON.stringify(revisions);
  let previous = '';
  try {
    previous = fs.readFileSync(revisionsFile, 'utf8');
  } catch {
    // First build.
  }
  if (previous === key && fs.existsSync(out)) {
    const now = new Date();
    fs.utimesSync(out, now, now);
    process.exit(2);
  }

  const lists = await Promise.all(
    LISTS.filter((name) => revisions[name]).map((name) => download(name, revisions[name])),
  );
  const resources = await download(RESOURCES, revisions[RESOURCES]);
  const engine = FiltersEngine.parse(lists.join('\n'), {
    enableMutationObserver: true,
    loadCosmeticFilters: true,
    loadNetworkFilters: true,
  });
  engine.updateResources(resources, revisions[RESOURCES]);

  const partial = `${out}.partial`;
  fs.writeFileSync(partial, engine.serialize());
  fs.renameSync(partial, out);
  fs.writeFileSync(revisionsFile, key);
  process.exit(0);
} catch (error) {
  console.error('adblock: building the filter engine failed:', error);
  process.exit(1);
}
